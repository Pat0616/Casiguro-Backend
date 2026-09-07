// backend/controllers/orderController.js
import pool from "../database/db.js";
import crypto from "crypto";
import { emitOrderCreated, emitOrderUpdated, emitNotification } from "../websocket/socket.js";

const STATUS_LABELS = {
  pending: "Pending",
  in_production: "In Production",
  ready: "Ready for Pickup",
  completed: "Completed",
};

const PAYMENT_LABELS = {
  unpaid: "Unpaid",
  partial: "Partially Paid",
  paid: "Fully Paid",
};

function formatCurrency(n) {
  return "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// GET /api/orders
export async function getOrders(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT
        o.id,
        o.ref_no AS refNo,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        o.product_name_snapshot AS product,
        COALESCE(cat.name, 'General') AS category,
        o.order_type AS orderType,
        o.quantity,
        o.quantity_completed AS quantityCompleted,
        CAST(o.unit_price AS DOUBLE) AS unitPrice,
        CAST(o.total_price AS DOUBLE) AS totalPrice,
        CAST(o.amount_paid AS DOUBLE) AS amountPaid,
        CAST(o.balance AS DOUBLE) AS balance,
        o.payment_status AS paymentStatus,
        o.status,
        COALESCE(o.notes, '') AS notes,
        o.date_ordered AS dateOrdered,
        o.due_date AS dueDate,
        o.date_completed AS dateCompleted
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN categories cat ON o.category_id = cat.id
      ORDER BY o.date_ordered DESC, o.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error("getOrders error:", err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
}

// GET /api/orders/:id
export async function getOrderById(req, res) {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `
      SELECT
        o.id,
        o.ref_no AS refNo,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        o.product_name_snapshot AS product,
        COALESCE(cat.name, 'General') AS category,
        o.order_type AS orderType,
        o.quantity,
        o.quantity_completed AS quantityCompleted,
        CAST(o.unit_price AS DOUBLE) AS unitPrice,
        CAST(o.total_price AS DOUBLE) AS totalPrice,
        CAST(o.amount_paid AS DOUBLE) AS amountPaid,
        CAST(o.balance AS DOUBLE) AS balance,
        o.payment_status AS paymentStatus,
        o.status,
        COALESCE(o.notes, '') AS notes,
        o.date_ordered AS dateOrdered,
        o.due_date AS dueDate,
        o.date_completed AS dateCompleted
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN categories cat ON o.category_id = cat.id
      WHERE o.id = ?
    `,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("getOrderById error:", err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
}

// POST /api/orders
export async function createOrder(req, res) {
  try {
    const {
      customerName,
      contactNumber,
      product,
      category,
      orderType = "custom",
      quantity: rawQty,
      unitPrice: rawPrice,
      notes = "",
      dateOrdered: rawDateOrdered,
      dueDate: rawDueDate,
    } = req.body;

    if (!customerName || !product) {
      return res.status(400).json({ message: "Customer name and product are required" });
    }

    const quantity = Math.max(1, Number(rawQty) || 1);
    const unitPrice = Math.max(0, Number(rawPrice) || 0);
    const isStock = orderType === "stock";
    const totalPrice = quantity * unitPrice;
    const quantityCompleted = isStock ? quantity : 0;
    const amountPaid = isStock ? totalPrice : 0;
    const balance = isStock ? 0 : totalPrice;
    const paymentStatus = isStock ? "paid" : "unpaid";
    const status = isStock ? "completed" : "pending";
    const todayStr = new Date().toISOString().slice(0, 10);
    const dateOrdered = rawDateOrdered || todayStr;
    const dueDate = rawDueDate || dateOrdered;
    const dateCompleted = isStock ? dateOrdered : null;

    // 1. Upsert Customer
    let customerId = null;
    const [custRows] = await pool.query("SELECT id, contact_number FROM customers WHERE full_name = ?", [customerName.trim()]);
    if (custRows.length > 0) {
      customerId = custRows[0].id;
      if (contactNumber && !custRows[0].contact_number) {
        await pool.query("UPDATE customers SET contact_number = ? WHERE id = ?", [contactNumber.trim(), customerId]);
      }
    } else {
      customerId = crypto.randomUUID();
      await pool.query(
        "INSERT INTO customers (id, full_name, contact_number) VALUES (?, ?, ?)",
        [customerId, customerName.trim(), contactNumber ? contactNumber.trim() : null]
      );
    }

    // 2. Upsert Category
    let categoryId = null;
    if (category) {
      const [catRows] = await pool.query("SELECT id FROM categories WHERE name = ?", [category.trim()]);
      if (catRows.length > 0) {
        categoryId = catRows[0].id;
      } else {
        categoryId = crypto.randomUUID();
        await pool.query("INSERT INTO categories (id, name) VALUES (?, ?)", [categoryId, category.trim()]);
      }
    }

    // 3. Generate Reference Number
    const year = dateOrdered.slice(0, 4) || new Date().getFullYear();
    const [countRows] = await pool.query("SELECT COUNT(*) AS total FROM orders WHERE ref_no LIKE ?", [`TXN-${year}-%`]);
    let nextNum = (countRows[0]?.total || 0) + 1;
    let refNo = `TXN-${year}-${String(nextNum).padStart(4, "0")}`;

    // Verify refNo uniqueness
    const [existingRef] = await pool.query("SELECT id FROM orders WHERE ref_no = ?", [refNo]);
    if (existingRef.length > 0) {
      refNo = `TXN-${year}-${String(nextNum + Math.floor(Math.random() * 1000)).padStart(4, "0")}`;
    }

    // 4. Resolve user
    const userId = req.user?.id || null;
    let userName = "Admin";
    if (userId) {
      const [userRows] = await pool.query("SELECT full_name FROM users WHERE id = ?", [userId]);
      if (userRows.length > 0) userName = userRows[0].full_name;
    }

    // 5. Insert Order
    const orderId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO orders (
        id, ref_no, customer_id, category_id, product_name_snapshot,
        order_type, quantity, quantity_completed, unit_price, total_price,
        amount_paid, balance, payment_status, status, notes,
        date_ordered, due_date, date_completed, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        refNo,
        customerId,
        categoryId,
        product.trim(),
        orderType,
        quantity,
        quantityCompleted,
        unitPrice,
        totalPrice,
        amountPaid,
        balance,
        paymentStatus,
        status,
        notes,
        dateOrdered,
        dueDate,
        dateCompleted,
        userId,
      ]
    );

    // 6. Create Persistent Notification (stored in MySQL for offline recovery)
    const notifId = crypto.randomUUID();
    const notifDetail = `New ${isStock ? "Stock" : "Custom"} Order created — ${product} × ${quantity}`;
    const now = new Date();

    await pool.query(
      `INSERT INTO notifications (
        id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
        notification_type, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        notifId,
        userId,
        userName,
        orderId,
        refNo,
        customerId,
        customerName.trim(),
        "new_order",
        notifDetail,
        now,
      ]
    );

    const createdOrder = {
      id: orderId,
      refNo,
      customerName: customerName.trim(),
      contactNumber: contactNumber ? contactNumber.trim() : "",
      product: product.trim(),
      category: category ? category.trim() : "General",
      orderType,
      quantity,
      quantityCompleted,
      unitPrice,
      totalPrice,
      amountPaid,
      balance,
      paymentStatus,
      status,
      notes,
      dateOrdered,
      dueDate,
      dateCompleted,
    };

    const createdNotif = {
      id: notifId,
      type: "new_order",
      user: userName,
      orderRef: refNo,
      customerName: customerName.trim(),
      detail: notifDetail,
      timestamp: now,
      readAt: null,
    };

    // 7. Emit Real-time WebSocket events to all connected clients
    emitOrderCreated(createdOrder);
    emitNotification(createdNotif);

    res.status(201).json(createdOrder);
  } catch (err) {
    console.error("createOrder error:", err);
    res.status(500).json({ message: "Failed to create order" });
  }
}

// PUT /api/orders/:id
export async function updateOrder(req, res) {
  try {
    const { id } = req.params;
    const {
      unitPrice: rawPrice,
      amountPaid: rawPaid,
      quantity: rawQty,
      quantityCompleted: rawQtyCompleted,
      status,
      paymentStatus,
    } = req.body;

    // 1. Fetch current order
    const [existingRows] = await pool.query(
      `
      SELECT
        o.*,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        COALESCE(cat.name, 'General') AS category
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN categories cat ON o.category_id = cat.id
      WHERE o.id = ?
    `,
      [id]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const current = existingRows[0];
    const unitPrice = Number(rawPrice ?? current.unit_price);
    const amountPaid = Number(rawPaid ?? current.amount_paid);
    const quantity = Number(rawQty ?? current.quantity);
    const quantityCompleted = Number(rawQtyCompleted ?? current.quantity_completed);
    const newStatus = status || current.status;
    const newPaymentStatus = paymentStatus || current.payment_status;

    const totalPrice = quantity * unitPrice;
    const balance = Math.max(totalPrice - amountPaid, 0);
    const todayStr = new Date().toISOString().slice(0, 10);
    const dateCompleted = newStatus === "completed" ? (current.date_completed || todayStr) : current.date_completed;

    const userId = req.user?.id || null;
    let userName = "Admin";
    if (userId) {
      const [userRows] = await pool.query("SELECT full_name FROM users WHERE id = ?", [userId]);
      if (userRows.length > 0) userName = userRows[0].full_name;
    }

    // 2. Update order in database
    await pool.query(
      `UPDATE orders SET
        unit_price = ?,
        total_price = ?,
        amount_paid = ?,
        balance = ?,
        quantity = ?,
        quantity_completed = ?,
        status = ?,
        payment_status = ?,
        date_completed = ?,
        updated_by = ?
      WHERE id = ?`,
      [
        unitPrice,
        totalPrice,
        amountPaid,
        balance,
        quantity,
        quantityCompleted,
        newStatus,
        newPaymentStatus,
        dateCompleted,
        userId,
        id,
      ]
    );

    // 3. Detect changes and create persistent notifications in MySQL
    const notificationsToEmit = [];
    const now = new Date();

    if (current.status !== newStatus) {
      const notifId = crypto.randomUUID();
      const oldLabel = STATUS_LABELS[current.status] || current.status;
      const newLabel = STATUS_LABELS[newStatus] || newStatus;
      const detail = `Order Status changed from ${oldLabel} → ${newLabel}`;

      await pool.query(
        `INSERT INTO notifications (
          id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
          notification_type, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          notifId,
          userId,
          userName,
          id,
          current.ref_no,
          current.customer_id,
          current.customerName,
          "status_update",
          detail,
          now,
        ]
      );

      notificationsToEmit.push({
        id: notifId,
        type: "status_update",
        user: userName,
        orderRef: current.ref_no,
        customerName: current.customerName,
        detail,
        timestamp: now,
        readAt: null,
      });
    }

    const diffs = [];
    if (Number(current.unit_price) !== unitPrice) {
      diffs.push(`Unit Price changed from ${formatCurrency(current.unit_price)} → ${formatCurrency(unitPrice)}`);
    }
    if (Number(current.amount_paid) !== amountPaid) {
      diffs.push(`Amount Paid changed from ${formatCurrency(current.amount_paid)} → ${formatCurrency(amountPaid)}`);
    }
    if (Number(current.quantity) !== quantity) {
      diffs.push(`Quantity Required changed from ${current.quantity} → ${quantity}`);
    }
    if (Number(current.quantity_completed) !== quantityCompleted) {
      diffs.push(`Quantity Completed changed from ${current.quantity_completed} → ${quantityCompleted}`);
    }
    if (current.payment_status !== newPaymentStatus) {
      diffs.push(`Payment Status changed from ${PAYMENT_LABELS[current.payment_status] || current.payment_status} → ${PAYMENT_LABELS[newPaymentStatus] || newPaymentStatus}`);
    }

    for (const d of diffs) {
      const notifId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO notifications (
          id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
          notification_type, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          notifId,
          userId,
          userName,
          id,
          current.ref_no,
          current.customer_id,
          current.customerName,
          "detail_update",
          d,
          now,
        ]
      );

      notificationsToEmit.push({
        id: notifId,
        type: "detail_update",
        user: userName,
        orderRef: current.ref_no,
        customerName: current.customerName,
        detail: d,
        timestamp: now,
        readAt: null,
      });
    }

    const updatedOrder = {
      id,
      refNo: current.ref_no,
      customerName: current.customerName,
      contactNumber: current.contactNumber,
      product: current.product_name_snapshot,
      category: current.category,
      orderType: current.order_type,
      quantity,
      quantityCompleted,
      unitPrice,
      totalPrice,
      amountPaid,
      balance,
      paymentStatus: newPaymentStatus,
      status: newStatus,
      notes: current.notes || "",
      dateOrdered: current.date_ordered,
      dueDate: current.due_date,
      dateCompleted,
    };

    // 4. Real-time WebSocket emission
    emitOrderUpdated(updatedOrder);
    notificationsToEmit.forEach((n) => emitNotification(n));

    res.json(updatedOrder);
  } catch (err) {
    console.error("updateOrder error:", err);
    res.status(500).json({ message: "Failed to update order" });
  }
}
