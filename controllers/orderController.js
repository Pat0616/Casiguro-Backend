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

// Helper to batch-load order items
async function attachItemsToOrders(orders) {
  if (!orders || orders.length === 0) return [];
  const orderIds = orders.map((o) => o.id);

  const [items] = await pool.query(
    `SELECT
      oi.id,
      oi.order_id AS orderId,
      oi.product_service_id AS productServiceId,
      oi.item_name_snapshot AS itemName,
      COALESCE(oi.item_description, '') AS itemDescription,
      COALESCE(oi.category_snapshot, 'General') AS category,
      oi.item_type AS itemType,
      oi.is_custom AS isCustom,
      oi.quantity,
      CAST(oi.base_price AS DOUBLE) AS basePrice,
      CAST(oi.final_unit_price AS DOUBLE) AS finalUnitPrice,
      oi.price_adjustment_reason AS priceAdjustmentReason,
      CAST(oi.subtotal AS DOUBLE) AS subtotal,
      oi.quantity_completed AS quantityCompleted,
      oi.production_progress AS productionProgress,
      oi.production_status AS productionStatus
    FROM order_items oi
    WHERE oi.order_id IN (?)
    ORDER BY oi.id ASC`,
    [orderIds]
  );

  const itemsByOrderId = {};
  for (const item of items) {
    if (!itemsByOrderId[item.orderId]) {
      itemsByOrderId[item.orderId] = [];
    }
    itemsByOrderId[item.orderId].push(item);
  }

  return orders.map((o) => {
    const orderItems = itemsByOrderId[o.id] || [];
    return {
      ...o,
      items: orderItems,
    };
  });
}

// GET /api/orders
export async function getOrders(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT
        o.id,
        o.ref_no AS refNo,
        o.quotation_id AS quotationId,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        o.product_name_snapshot AS product,
        COALESCE(cat.name, 'General') AS category,
        o.order_type AS orderType,
        o.quantity,
        o.quantity_completed AS quantityCompleted,
        o.overall_progress AS overallProgress,
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

    const ordersWithItems = await attachItemsToOrders(rows);
    res.json(ordersWithItems);
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
        o.quotation_id AS quotationId,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        o.product_name_snapshot AS product,
        COALESCE(cat.name, 'General') AS category,
        o.order_type AS orderType,
        o.quantity,
        o.quantity_completed AS quantityCompleted,
        o.overall_progress AS overallProgress,
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

    const [orderWithItems] = await attachItemsToOrders(rows);
    res.json(orderWithItems);
  } catch (err) {
    console.error("getOrderById error:", err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
}

// POST /api/orders (Direct creation or fallback)
export async function createOrder(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

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
      items: rawItems,
    } = req.body;

    if (!customerName || !customerName.trim()) {
      await conn.rollback();
      return res.status(400).json({ message: "Customer name is required" });
    }

    // 1. Resolve Customer
    let customerId = null;
    const [custRows] = await conn.query("SELECT id, contact_number FROM customers WHERE full_name = ?", [customerName.trim()]);
    if (custRows.length > 0) {
      customerId = custRows[0].id;
      if (contactNumber && !custRows[0].contact_number) {
        await conn.query("UPDATE customers SET contact_number = ? WHERE id = ?", [contactNumber.trim(), customerId]);
      }
    } else {
      customerId = crypto.randomUUID();
      await conn.query(
        "INSERT INTO customers (id, full_name, contact_number) VALUES (?, ?, ?)",
        [customerId, customerName.trim(), contactNumber ? contactNumber.trim() : null]
      );
    }

    // 2. Resolve Category
    let categoryId = null;
    if (category) {
      const [catRows] = await conn.query("SELECT id FROM categories WHERE name = ?", [category.trim()]);
      if (catRows.length > 0) {
        categoryId = catRows[0].id;
      } else {
        categoryId = crypto.randomUUID();
        await conn.query("INSERT INTO categories (id, name) VALUES (?, ?)", [categoryId, category.trim()]);
      }
    }

    // 3. Generate Reference Number
    const todayStr = new Date().toISOString().slice(0, 10);
    const dateOrdered = rawDateOrdered || todayStr;
    const dueDate = rawDueDate || dateOrdered;
    const year = dateOrdered.slice(0, 4) || new Date().getFullYear();
    const [countRows] = await conn.query("SELECT COUNT(*) AS total FROM orders WHERE ref_no LIKE ?", [`TXN-${year}-%`]);
    let nextNum = (countRows[0]?.total || 0) + 1;
    let refNo = `TXN-${year}-${String(nextNum).padStart(4, "0")}`;
    const [existingRef] = await conn.query("SELECT id FROM orders WHERE ref_no = ?", [refNo]);
    if (existingRef.length > 0) {
      refNo = `TXN-${year}-${String(nextNum + Math.floor(Math.random() * 1000)).padStart(4, "0")}`;
    }

    // 4. Determine items
    let preparedItems = [];
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      preparedItems = rawItems.map((it) => {
        const q = Math.max(1, Number(it.quantity) || 1);
        const p = Math.max(0, Number(it.finalUnitPrice ?? it.unitPrice ?? it.basePrice) || 0);
        const bp = Math.max(0, Number(it.basePrice) || p);
        return {
          id: crypto.randomUUID(),
          productServiceId: it.productServiceId || null,
          itemName: it.itemName || it.product || "Printing Item",
          itemDescription: it.itemDescription || "",
          category: it.category || category || "General",
          itemType: it.itemType || "product",
          isCustom: Boolean(it.isCustom ?? (orderType === "custom")),
          quantity: q,
          basePrice: bp,
          finalUnitPrice: p,
          priceAdjustmentReason: it.priceAdjustmentReason || null,
          subtotal: Number((q * p).toFixed(2)),
          quantityCompleted: 0,
          productionProgress: 0,
          productionStatus: "pending",
        };
      });
    } else {
      const q = Math.max(1, Number(rawQty) || 1);
      const p = Math.max(0, Number(rawPrice) || 0);
      preparedItems.push({
        id: crypto.randomUUID(),
        productServiceId: null,
        itemName: (product || "Custom Printing").trim(),
        itemDescription: notes ? notes.trim() : "",
        category: category ? category.trim() : "General",
        itemType: "product",
        isCustom: orderType === "custom",
        quantity: q,
        basePrice: p,
        finalUnitPrice: p,
        priceAdjustmentReason: null,
        subtotal: Number((q * p).toFixed(2)),
        quantityCompleted: 0,
        productionProgress: 0,
        productionStatus: "pending",
      });
    }

    const totalQuantity = preparedItems.reduce((sum, it) => sum + it.quantity, 0);
    const totalPrice = preparedItems.reduce((sum, it) => sum + it.subtotal, 0);
    const isStock = orderType === "stock";
    const quantityCompleted = isStock ? totalQuantity : 0;
    const amountPaid = isStock ? totalPrice : 0;
    const balance = isStock ? 0 : totalPrice;
    const paymentStatus = isStock ? "paid" : "unpaid";
    const status = isStock ? "completed" : "pending";
    const overallProgress = isStock ? 100 : 0;
    const dateCompleted = isStock ? dateOrdered : null;
    const productNameSnapshot = preparedItems.map((i) => i.itemName).join(", ").slice(0, 150);

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Staff";
    const orderId = crypto.randomUUID();

    // 5. Insert Order
    await conn.query(
      `INSERT INTO orders (
        id, ref_no, customer_id, category_id, product_name_snapshot,
        order_type, quantity, quantity_completed, overall_progress,
        unit_price, total_price, amount_paid, balance,
        payment_status, status, notes,
        date_ordered, due_date, date_completed, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        refNo,
        customerId,
        categoryId,
        productNameSnapshot,
        orderType,
        totalQuantity,
        quantityCompleted,
        overallProgress,
        preparedItems[0]?.finalUnitPrice || 0,
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

    // 6. Insert Order Items
    for (const item of preparedItems) {
      await conn.query(
        `INSERT INTO order_items (
          id, order_id, product_service_id, item_name_snapshot,
          item_description, category_snapshot, item_type, is_custom,
          quantity, base_price, final_unit_price, price_adjustment_reason,
          subtotal, quantity_completed, production_progress, production_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          orderId,
          item.productServiceId,
          item.itemName,
          item.itemDescription,
          item.category,
          item.itemType,
          item.isCustom,
          item.quantity,
          item.basePrice,
          item.finalUnitPrice,
          item.priceAdjustmentReason,
          item.subtotal,
          isStock ? item.quantity : 0,
          isStock ? 100 : 0,
          isStock ? "completed" : "pending",
        ]
      );
    }

    // 7. Insert Notification
    const notifId = crypto.randomUUID();
    const notifDetail = `New ${isStock ? "Stock" : "Custom"} Order created — ${productNameSnapshot} (₱${totalPrice.toFixed(2)})`;
    const now = new Date();

    await conn.query(
      `INSERT INTO notifications (
        id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
        notification_type, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'new_order', ?, ?)`,
      [
        notifId,
        userId,
        userName,
        orderId,
        refNo,
        customerId,
        customerName.trim(),
        notifDetail,
        now,
      ]
    );

    await conn.commit();

    const createdOrder = {
      id: orderId,
      refNo,
      customerName: customerName.trim(),
      contactNumber: contactNumber ? contactNumber.trim() : "",
      product: productNameSnapshot,
      category: category ? category.trim() : "General",
      orderType,
      quantity: totalQuantity,
      quantityCompleted,
      overallProgress,
      unitPrice: preparedItems[0]?.finalUnitPrice || 0,
      totalPrice,
      amountPaid,
      balance,
      paymentStatus,
      status,
      notes,
      dateOrdered,
      dueDate,
      dateCompleted,
      items: preparedItems,
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

    emitOrderCreated(createdOrder);
    emitNotification(createdNotif);

    res.status(201).json(createdOrder);
  } catch (err) {
    await conn.rollback();
    console.error("createOrder error:", err);
    res.status(500).json({ message: "Failed to create order" });
  } finally {
    conn.release();
  }
}

// PUT /api/orders/:id (General update)
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

    const [existingRows] = await pool.query(
      `SELECT
        o.*,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        COALESCE(cat.name, 'General') AS category
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN categories cat ON o.category_id = cat.id
      WHERE o.id = ?`,
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
    const overallProgress = quantity > 0 ? Math.min(100, Math.round((quantityCompleted / quantity) * 100)) : 0;

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Staff";

    await pool.query(
      `UPDATE orders SET
        unit_price = ?,
        total_price = ?,
        amount_paid = ?,
        balance = ?,
        quantity = ?,
        quantity_completed = ?,
        overall_progress = ?,
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
        overallProgress,
        newStatus,
        newPaymentStatus,
        dateCompleted,
        userId,
        id,
      ]
    );

    const [updatedOrderRows] = await pool.query(
      `SELECT
        o.id,
        o.ref_no AS refNo,
        o.quotation_id AS quotationId,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        o.product_name_snapshot AS product,
        COALESCE(cat.name, 'General') AS category,
        o.order_type AS orderType,
        o.quantity,
        o.quantity_completed AS quantityCompleted,
        o.overall_progress AS overallProgress,
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
      WHERE o.id = ?`,
      [id]
    );

    const [fullOrder] = await attachItemsToOrders(updatedOrderRows);
    emitOrderUpdated(fullOrder);

    res.json(fullOrder);
  } catch (err) {
    console.error("updateOrder error:", err);
    res.status(500).json({ message: "Failed to update order" });
  }
}

// PUT /api/orders/:id/production
// ITEM-LEVEL PRODUCTION MONITORING & PURE QUANTITY-WEIGHTED AGGREGATION
export async function updateItemProduction(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const {
      items: updatedItemsList,
      itemId,
      quantityCompleted: singleQtyCompleted,
      allowIncompletePaymentCompletion = false,
    } = req.body;

    const [existingOrders] = await conn.query("SELECT * FROM orders WHERE id = ? FOR UPDATE", [id]);
    if (existingOrders.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Order not found" });
    }
    const order = existingOrders[0];

    // Fetch existing items FOR UPDATE
    const [existingItems] = await conn.query("SELECT * FROM order_items WHERE order_id = ? FOR UPDATE", [id]);

    // Handle updates: either a batch of items or single item
    const updatesToApply = [];
    if (Array.isArray(updatedItemsList) && updatedItemsList.length > 0) {
      for (const u of updatedItemsList) {
        updatesToApply.push({ id: u.id, quantityCompleted: Number(u.quantityCompleted) || 0 });
      }
    } else if (itemId) {
      updatesToApply.push({ id: itemId, quantityCompleted: Number(singleQtyCompleted) || 0 });
    }

    for (const update of updatesToApply) {
      const match = existingItems.find((it) => it.id === update.id);
      if (match) {
        const qtyReq = Number(match.quantity);
        const qtyComp = Math.max(0, Math.min(qtyReq, update.quantityCompleted));
        const itemProgress = qtyReq > 0 ? Math.min(100, Math.round((qtyComp / qtyReq) * 100)) : 0;
        let itemStatus = "pending";
        if (itemProgress >= 100) itemStatus = "completed";
        else if (itemProgress > 0) itemStatus = "in_production";

        await conn.query(
          `UPDATE order_items SET
            quantity_completed = ?,
            production_progress = ?,
            production_status = ?
          WHERE id = ?`,
          [qtyComp, itemProgress, itemStatus, update.id]
        );

        // Update local object for subsequent total calculation
        match.quantity_completed = qtyComp;
        match.production_progress = itemProgress;
        match.production_status = itemStatus;
      }
    }

    // ENTERPRISE CALCULATION: Pure Quantity-Weighted Progress
    // Overall Progress = (SUM(quantity_completed) / SUM(quantity)) * 100
    const totalOrderQty = existingItems.reduce((sum, it) => sum + Number(it.quantity), 0);
    const totalOrderCompleted = existingItems.reduce((sum, it) => sum + Number(it.quantity_completed), 0);
    const overallProgress = totalOrderQty > 0 ? Math.min(100, Math.round((totalOrderCompleted / totalOrderQty) * 100)) : 0;

    // Derived overall order production status
    let derivedStatus = "pending";
    if (overallProgress >= 100) {
      const hasOutstandingBalance = Number(order.total_price) > Number(order.amount_paid);
      derivedStatus = hasOutstandingBalance && !allowIncompletePaymentCompletion ? "ready" : "completed";
    } else if (overallProgress > 0) {
      derivedStatus = "in_production";
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const dateCompleted = derivedStatus === "completed" ? (order.date_completed || todayStr) : null;

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Production Team";

    // Update parent order
    await conn.query(
      `UPDATE orders SET
        quantity = ?,
        quantity_completed = ?,
        overall_progress = ?,
        status = ?,
        date_completed = ?,
        updated_by = ?
      WHERE id = ?`,
      [
        totalOrderQty,
        totalOrderCompleted,
        overallProgress,
        derivedStatus,
        dateCompleted,
        userId,
        id,
      ]
    );

    // Create persistent notification if status changed or 100% completed
    if (order.status !== derivedStatus) {
      const notifId = crypto.randomUUID();
      const oldLabel = STATUS_LABELS[order.status] || order.status;
      const newLabel = STATUS_LABELS[derivedStatus] || derivedStatus;
      const detail = `Order ${order.ref_no} production status changed from ${oldLabel} to ${newLabel} (${overallProgress}% completed)`;

      await conn.query(
        `INSERT INTO notifications (
          id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
          notification_type, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, (SELECT full_name FROM customers WHERE id = ?), 'status_update', ?, NOW())`,
        [notifId, userId, userName, id, order.ref_no, order.customer_id, order.customer_id, detail]
      );
    }

    await conn.commit();

    // Fetch updated order with items to return and broadcast
    const [updatedOrderRows] = await pool.query(
      `SELECT
        o.id,
        o.ref_no AS refNo,
        o.quotation_id AS quotationId,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        o.product_name_snapshot AS product,
        COALESCE(cat.name, 'General') AS category,
        o.order_type AS orderType,
        o.quantity,
        o.quantity_completed AS quantityCompleted,
        o.overall_progress AS overallProgress,
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
      WHERE o.id = ?`,
      [id]
    );

    const [fullOrder] = await attachItemsToOrders(updatedOrderRows);
    emitOrderUpdated(fullOrder);

    res.json({
      message: "Item production updated successfully",
      order: fullOrder,
    });
  } catch (err) {
    await conn.rollback();
    console.error("updateItemProduction error:", err);
    res.status(500).json({ message: "Failed to update item production" });
  } finally {
    conn.release();
  }
}

// POST /api/orders/:id/payment
// RECORD FINANCIAL TRANSACTION SETTLEMENT
export async function recordPayment(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { amount: rawAmount, paymentMethod = "Cash", note = "" } = req.body;

    const amount = Number(rawAmount) || 0;
    if (amount <= 0) {
      await conn.rollback();
      return res.status(400).json({ message: "Payment amount must be greater than 0" });
    }

    const [orderRows] = await conn.query("SELECT * FROM orders WHERE id = ? FOR UPDATE", [id]);
    if (orderRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Order not found" });
    }

    const order = orderRows[0];
    const currentPaid = Number(order.amount_paid);
    const totalPrice = Number(order.total_price);
    const newPaid = Math.min(totalPrice, currentPaid + amount);
    const newBalance = Math.max(0, totalPrice - newPaid);
    const newPaymentStatus = newBalance === 0 ? "paid" : "partial";

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Billing Staff";

    // 1. Insert into payments log
    const paymentId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO payments (id, order_id, amount, payment_method, note, created_by, received_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [paymentId, id, amount, paymentMethod, note ? note.trim() : null, userId]
    );

    // 2. Update order financial state
    await conn.query(
      `UPDATE orders SET
        amount_paid = ?,
        balance = ?,
        payment_status = ?,
        updated_by = ?
      WHERE id = ?`,
      [newPaid, newBalance, newPaymentStatus, userId, id]
    );

    // 3. Create persistent notification
    const notifId = crypto.randomUUID();
    const notifDetail = `Payment of ${formatCurrency(amount)} recorded for Order ${order.ref_no} via ${paymentMethod}. New balance: ${formatCurrency(newBalance)}`;

    await conn.query(
      `INSERT INTO notifications (
        id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
        notification_type, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, (SELECT full_name FROM customers WHERE id = ?), 'detail_update', ?, NOW())`,
      [notifId, userId, userName, id, order.ref_no, order.customer_id, order.customer_id, notifDetail]
    );

    await conn.commit();

    // Fetch updated order with items
    const [updatedOrderRows] = await pool.query(
      `SELECT
        o.id,
        o.ref_no AS refNo,
        o.quotation_id AS quotationId,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        o.product_name_snapshot AS product,
        COALESCE(cat.name, 'General') AS category,
        o.order_type AS orderType,
        o.quantity,
        o.quantity_completed AS quantityCompleted,
        o.overall_progress AS overallProgress,
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
      WHERE o.id = ?`,
      [id]
    );

    const [fullOrder] = await attachItemsToOrders(updatedOrderRows);
    emitOrderUpdated(fullOrder);

    res.json({
      message: "Payment recorded successfully",
      payment: { id: paymentId, amount, paymentMethod, balance: newBalance, paymentStatus: newPaymentStatus },
      order: fullOrder,
    });
  } catch (err) {
    await conn.rollback();
    console.error("recordPayment error:", err);
    res.status(500).json({ message: "Failed to record payment" });
  } finally {
    conn.release();
  }
}
