// backend/controllers/orderController.js
import pool from "../database/db.js";
import crypto from "crypto";
import { emitOrderCreated, emitOrderUpdated, emitNotification } from "../websocket/socket.js";
import { DOCUMENT_COLUMNS, DOCUMENT_LABELS, generateSoaNumber, parseDocumentFields } from "../utils/orderDocuments.js";
import { diffFields, logAudit } from "../utils/auditLog.js";
import {
  attachPaymentsToOrders,
  describePayment,
  insertPayment,
  parsePaymentInput,
  recalcOrderPayments,
} from "../utils/payments.js";

export const ORDER_SELECT = `
  SELECT
    o.id,
    o.soa_no AS soaNo,
    o.soa_date AS soaDate,
    o.pr_no AS prNo,
    o.po_no AS poNo,
    o.jo_no AS joNo,
    o.si_or_no AS siOrNo,
    o.si_or_date AS siOrDate,
    o.dr_no AS drNo,
    o.dr_date AS drDate,
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
    o.date_completed AS dateCompleted,
    o.cancelled_at AS cancelledAt,
    o.cancel_reason AS cancelReason,
    COALESCE(cu.full_name, '') AS cancelledByName
  FROM orders o
  LEFT JOIN customers c ON o.customer_id = c.id
  LEFT JOIN categories cat ON o.category_id = cat.id
  LEFT JOIN users cu ON o.cancelled_by = cu.id
`;

const STATUS_LABELS = {
  pending: "Pending",
  in_production: "In Production",
  ready: "Ready for Pickup",
  completed: "Completed",
  cancelled: "Cancelled",
};

const PAYMENT_LABELS = {
  unpaid: "Unpaid",
  partial: "Partially Paid",
  paid: "Fully Paid",
};

function formatCurrency(n) {
  return "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// One order with its items and payments, as the API returns it
export async function loadFullOrder(id) {
  const [rows] = await pool.query(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
  const [fullOrder] = await attachItemsToOrders(rows);
  return fullOrder || null;
}

// Inserts a persistent notification and returns it in the shape the socket/frontend expects.
// `event` is the exact action (e.g. payment.void); the frontend picks the icon from it.
async function insertNotification(conn, { userId, userName, order, customerName, type, event, detail }) {
  const id = crypto.randomUUID();
  const now = new Date();
  await conn.query(
    `INSERT INTO notifications (
      id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
      notification_type, event, message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, userName, order.id, order.soa_no, order.customer_id, customerName, type, event, detail, now]
  );
  return { id, type, event, user: userName, orderRef: order.soa_no, customerName, detail, timestamp: now, readAt: null };
}

// Helper to batch-load order items (and payments)
export async function attachItemsToOrders(orders) {
  if (!orders || orders.length === 0) return [];
  const orderIds = orders.map((o) => o.id);

  const [items] = await pool.query(
    `SELECT
      oi.id,
      oi.order_id AS orderId,
      oi.product_service_id AS productServiceId,
      oi.item_name_snapshot AS itemName,
      oi.variant_snapshot AS selectedVariant,
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

  return attachPaymentsToOrders(
    orders.map((o) => {
      const orderItems = itemsByOrderId[o.id] || [];
      return {
        ...o,
        items: orderItems,
      };
    })
  );
}

// GET /api/orders
export async function getOrders(req, res) {
  try {
    const [rows] = await pool.query(`${ORDER_SELECT} ORDER BY o.date_ordered DESC, o.created_at DESC`);

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
    const [rows] = await pool.query(`${ORDER_SELECT} WHERE o.id = ?`, [id]);

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
      downPayment,
      stockPayment,
    } = req.body;

    if (!customerName || !customerName.trim()) {
      await conn.rollback();
      return res.status(400).json({ message: "Customer name is required" });
    }

    const { fields: parsedDocuments, error: documentError } = parseDocumentFields(req.body);
    if (documentError) {
      await conn.rollback();
      return res.status(400).json({ message: documentError });
    }
    const documents = Object.fromEntries(Object.keys(DOCUMENT_COLUMNS).map((key) => [key, parsedDocuments[key] ?? null]));

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

    // 3. Generate SOA Number
    // soaDate is the database's today (Asia/Manila); new Date().toISOString() would give the UTC date before 8 AM
    const { soaNo, soaDate } = await generateSoaNumber(conn);
    const dateOrdered = rawDateOrdered || soaDate;
    const dueDate = rawDueDate || dateOrdered;

    // 4. Determine items
    let preparedItems = [];
    if (Array.isArray(rawItems) && rawItems.length > 0) {
      for (const [index, item] of rawItems.entries()) {
        if (
          item.selectedVariant != null &&
          (typeof item.selectedVariant !== "string" || !item.selectedVariant.trim() || item.selectedVariant.trim().length > 150)
        ) {
          await conn.rollback();
          return res.status(400).json({ message: `Item #${index + 1} has an invalid option name` });
        }
      }
      preparedItems = rawItems.map((it) => {
        const q = Math.max(1, Number(it.quantity) || 1);
        const p = Math.max(0, Number(it.finalUnitPrice ?? it.unitPrice ?? it.basePrice) || 0);
        const bp = Math.max(0, Number(it.basePrice ?? p) || 0);
        return {
          id: crypto.randomUUID(),
          productServiceId: it.productServiceId || null,
          itemName: it.itemName || it.product || "Printing Item",
          selectedVariant: typeof it.selectedVariant === "string" ? it.selectedVariant.trim() || null : null,
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
        selectedVariant: null,
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

    // Stock orders are paid in full on the spot; custom orders may come with a down payment.
    // Either becomes a payments row, and the order's money columns are derived from it below.
    let initialPayment = null;
    if (isStock && totalPrice > 0) {
      // stockPayment: { method (default cash), referenceNo?, orNo?, ... }; the amount is always the full total
      initialPayment = { ...stockPayment, method: stockPayment?.method || "cash", paymentType: "payment", amount: totalPrice };
    } else if (!isStock && downPayment && Number(downPayment.amount) > 0) {
      initialPayment = { ...downPayment, paymentType: "down_payment" };
    }
    let paymentFields = null;
    if (initialPayment) {
      const { fields, error } = parsePaymentInput(initialPayment, totalPrice);
      if (error) {
        await conn.rollback();
        return res.status(400).json({ message: `${isStock ? "Payment" : "Down payment"}: ${error}` });
      }
      paymentFields = fields;
    }

    const quantityCompleted = isStock ? totalQuantity : 0;
    const amountPaid = 0;
    const balance = totalPrice;
    const paymentStatus = "unpaid";
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
        id, soa_no, soa_date, pr_no, po_no, jo_no, si_or_no, si_or_date, dr_no, dr_date,
        customer_id, category_id, product_name_snapshot,
        order_type, quantity, quantity_completed, overall_progress,
        unit_price, total_price, amount_paid, balance,
        payment_status, status, notes,
        date_ordered, due_date, date_completed, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId,
        soaNo,
        soaDate,
        documents.prNo,
        documents.poNo,
        documents.joNo,
        documents.siOrNo,
        documents.siOrDate,
        documents.drNo,
        documents.drDate,
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
          item_description, variant_snapshot, category_snapshot, item_type, is_custom,
          quantity, base_price, final_unit_price, price_adjustment_reason,
          subtotal, quantity_completed, production_progress, production_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          orderId,
          item.productServiceId,
          item.itemName,
          item.itemDescription,
          item.selectedVariant,
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

    if (paymentFields) {
      await insertPayment(conn, orderId, paymentFields, userId);
      await recalcOrderPayments(conn, orderId);
    }

    // 7. Insert Notification
    const notifId = crypto.randomUUID();
    const notifDetail = `New ${isStock ? "Stock" : "Custom"} Order created — ${productNameSnapshot} (₱${totalPrice.toFixed(2)})${
      paymentFields ? `. ${describePayment(paymentFields)}` : ""
    }`;
    const now = new Date();

    await conn.query(
      `INSERT INTO notifications (
        id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
        notification_type, event, message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'new_order', 'order.create', ?, ?)`,
      [
        notifId,
        userId,
        userName,
        orderId,
        soaNo,
        customerId,
        customerName.trim(),
        notifDetail,
        now,
      ]
    );

    await logAudit(conn, req, {
      action: "order.create",
      category: "order",
      entityType: "order",
      entityId: orderId,
      entityLabel: `SOA ${soaNo}`,
      description: `Created ${isStock ? "stock" : "custom"} order SOA ${soaNo} for ${customerName.trim()}: ${productNameSnapshot} (${formatCurrency(totalPrice)})`,
    });
    if (paymentFields) {
      await logAudit(conn, req, {
        action: "payment.record",
        category: "payment",
        entityType: "order",
        entityId: orderId,
        entityLabel: `SOA ${soaNo}`,
        description: `Recorded ${describePayment(paymentFields)} on SOA ${soaNo}`,
      });
    }

    await conn.commit();

    const createdOrder = await loadFullOrder(orderId);

    const createdNotif = {
      id: notifId,
      type: "new_order",
      event: "order.create",
      user: userName,
      orderRef: soaNo,
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

// PUT /api/orders/:id (General update: production quantity / status for orders without items)
// Money is never written here: totals come from the items and payments from POST /:id/payments.
const EDITABLE_STATUSES = ["pending", "in_production", "ready", "completed"];

export async function updateOrder(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { quantityCompleted: rawQtyCompleted, status } = req.body;

    if (status != null && !EDITABLE_STATUSES.includes(status)) {
      await conn.rollback();
      return res.status(400).json({ message: "Invalid order status" });
    }

    const [existingRows] = await conn.query(
      `SELECT
        o.*,
        COALESCE(c.full_name, '') AS customerName,
        COALESCE(c.contact_number, '') AS contactNumber,
        COALESCE(cat.name, 'General') AS category
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN categories cat ON o.category_id = cat.id
      WHERE o.id = ?
      FOR UPDATE`,
      [id]
    );

    if (existingRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Order not found" });
    }

    const current = existingRows[0];
    if (current.status === "cancelled") {
      await conn.rollback();
      return res.status(400).json({ message: "Cancelled orders can't be updated" });
    }
    const quantity = Number(current.quantity);
    const quantityCompleted = Math.max(0, Math.min(quantity, Number(rawQtyCompleted ?? current.quantity_completed) || 0));
    const newStatus = status || current.status;

    const [[{ today }]] = await conn.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
    const dateCompleted = newStatus === "completed" ? (current.date_completed || today) : current.date_completed;
    const overallProgress = quantity > 0 ? Math.min(100, Math.round((quantityCompleted / quantity) * 100)) : 0;

    const userId = req.user?.id || null;

    await conn.query(
      `UPDATE orders SET
        quantity_completed = ?,
        overall_progress = ?,
        status = ?,
        date_completed = ?,
        updated_by = ?
      WHERE id = ?`,
      [quantityCompleted, overallProgress, newStatus, dateCompleted, userId, id]
    );

    const before = { quantityCompleted: Number(current.quantity_completed), status: current.status };
    const after = { quantityCompleted, status: newStatus };
    const label = `SOA ${current.soa_no}`;
    const orderChanges = diffFields(before, after, ["quantityCompleted", "status"]);
    if (orderChanges) {
      await logAudit(conn, req, {
        action: "order.update",
        category: "order",
        entityType: "order",
        entityId: id,
        entityLabel: label,
        description: `Updated ${label}${orderChanges.status ? `: status ${STATUS_LABELS[before.status] || before.status} → ${STATUS_LABELS[newStatus] || newStatus}` : ""}`,
        changes: orderChanges,
      });
    }

    await conn.commit();

    const fullOrder = await loadFullOrder(id);
    emitOrderUpdated(fullOrder);

    res.json(fullOrder);
  } catch (err) {
    await conn.rollback();
    console.error("updateOrder error:", err);
    res.status(500).json({ message: "Failed to update order" });
  } finally {
    conn.release();
  }
}

// PUT /api/orders/:id/documents
// OPTIONAL REFERENCE DOCUMENTS (PR, PO, SI/OR, DR) — SOA No/Date are system-assigned and never edited here
export async function updateOrderDocuments(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;

    const { fields, error } = parseDocumentFields(req.body);
    if (error) {
      await conn.rollback();
      return res.status(400).json({ message: error });
    }

    const [orderRows] = await conn.query(
      `SELECT o.*, COALESCE(c.full_name, '') AS customerName
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE o.id = ? FOR UPDATE`,
      [id]
    );
    if (orderRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Order not found" });
    }

    const order = orderRows[0];
    const changedKeys = Object.keys(fields).filter((key) => (order[DOCUMENT_COLUMNS[key]] ?? null) !== fields[key]);

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Staff";
    let createdNotif = null;

    if (changedKeys.length > 0) {
      await conn.query(
        `UPDATE orders SET ${changedKeys.map((key) => `${DOCUMENT_COLUMNS[key]} = ?`).join(", ")}, updated_by = ? WHERE id = ?`,
        [...changedKeys.map((key) => fields[key]), userId, id]
      );

      const notifId = crypto.randomUUID();
      const detail = `Reference documents updated for SOA ${order.soa_no}: ${changedKeys
        .map((key) => `${DOCUMENT_LABELS[key]} ${fields[key] ? `set to ${fields[key]}` : "cleared"}`)
        .join(", ")}`;
      const now = new Date();

      await conn.query(
        `INSERT INTO notifications (
          id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
          notification_type, event, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'detail_update', 'order.documents_update', ?, ?)`,
        [notifId, userId, userName, id, order.soa_no, order.customer_id, order.customerName, detail, now]
      );

      await logAudit(conn, req, {
        action: "order.documents_update",
        category: "order",
        entityType: "order",
        entityId: id,
        entityLabel: `SOA ${order.soa_no}`,
        description: detail,
        changes: Object.fromEntries(
          changedKeys.map((key) => [DOCUMENT_LABELS[key], { from: order[DOCUMENT_COLUMNS[key]] ?? null, to: fields[key] }])
        ),
      });

      createdNotif = {
        id: notifId,
        type: "detail_update",
        event: "order.documents_update",
        user: userName,
        orderRef: order.soa_no,
        customerName: order.customerName,
        detail,
        timestamp: now,
        readAt: null,
      };
    }

    await conn.commit();

    const [updatedOrderRows] = await pool.query(`${ORDER_SELECT} WHERE o.id = ?`, [id]);
    const [fullOrder] = await attachItemsToOrders(updatedOrderRows);

    if (createdNotif) {
      emitOrderUpdated(fullOrder);
      emitNotification(createdNotif);
    }

    res.json(fullOrder);
  } catch (err) {
    await conn.rollback();
    console.error("updateOrderDocuments error:", err);
    res.status(500).json({ message: "Failed to update order documents" });
  } finally {
    conn.release();
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
    if (order.status === "cancelled") {
      await conn.rollback();
      return res.status(400).json({ message: "Cancelled orders can't be updated" });
    }

    // Fetch existing items FOR UPDATE
    const [existingItems] = await conn.query("SELECT * FROM order_items WHERE order_id = ? FOR UPDATE", [id]);

    // Handle updates: either a batch of items or single item
    const updatesToApply = [];
    if (Array.isArray(updatedItemsList) && updatedItemsList.length > 0) {
      for (const u of updatedItemsList) {
        updatesToApply.push({
          id: u.id,
          quantityCompleted: Number(u.quantityCompleted) || 0,
          previousQuantityCompleted: u.previousQuantityCompleted,
        });
      }
    } else if (itemId) {
      updatesToApply.push({ id: itemId, quantityCompleted: Number(singleQtyCompleted) || 0 });
    }

    // Optimistic concurrency: the client sends the value it started from. If someone saved this item since,
    // refuse the whole save instead of silently overwriting their progress.
    for (const update of updatesToApply) {
      const match = existingItems.find((it) => it.id === update.id);
      if (!match || update.previousQuantityCompleted == null) continue;
      if (Number(update.previousQuantityCompleted) !== Number(match.quantity_completed)) {
        await conn.rollback();
        const itemLabel = match.variant_snapshot ? `${match.item_name_snapshot} (${match.variant_snapshot})` : match.item_name_snapshot;
        return res.status(409).json({
          message: `${itemLabel} was updated by someone else (now ${match.quantity_completed}/${match.quantity}). Your changes were not saved.`,
          conflict: true,
        });
      }
    }

    const itemChanges = {};
    for (const update of updatesToApply) {
      const match = existingItems.find((it) => it.id === update.id);
      if (match) {
        const qtyReq = Number(match.quantity);
        const qtyComp = Math.max(0, Math.min(qtyReq, update.quantityCompleted));
        const prevComp = Number(match.quantity_completed);
        if (prevComp !== qtyComp) {
          const itemLabel = match.variant_snapshot ? `${match.item_name_snapshot} (${match.variant_snapshot})` : match.item_name_snapshot;
          itemChanges[`${itemLabel} completed`] = { from: `${prevComp}/${qtyReq}`, to: `${qtyComp}/${qtyReq}` };
        }
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
      const hasOutstandingBalance = Number(order.balance) > 0;
      derivedStatus = hasOutstandingBalance && !allowIncompletePaymentCompletion ? "ready" : "completed";
    } else if (overallProgress > 0) {
      derivedStatus = "in_production";
    }

    const [[{ today }]] = await conn.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
    const dateCompleted = derivedStatus === "completed" ? (order.date_completed || today) : null;

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

    if (order.status !== derivedStatus) {
      itemChanges.status = { from: order.status, to: derivedStatus };
    }
    if (Object.keys(itemChanges).length > 0) {
      await logAudit(conn, req, {
        action: "order.production_update",
        category: "order",
        entityType: "order",
        entityId: id,
        entityLabel: `SOA ${order.soa_no}`,
        description: `Updated production on SOA ${order.soa_no}: ${totalOrderCompleted}/${totalOrderQty} pcs (${overallProgress}%)${
          order.status !== derivedStatus ? `, status ${STATUS_LABELS[order.status] || order.status} → ${STATUS_LABELS[derivedStatus] || derivedStatus}` : ""
        }`,
        changes: itemChanges,
      });
    }

    // Create persistent notification if status changed or 100% completed
    if (order.status !== derivedStatus) {
      const notifId = crypto.randomUUID();
      const oldLabel = STATUS_LABELS[order.status] || order.status;
      const newLabel = STATUS_LABELS[derivedStatus] || derivedStatus;
      const detail = `SOA ${order.soa_no} production status changed from ${oldLabel} to ${newLabel} (${overallProgress}% completed)`;

      await conn.query(
        `INSERT INTO notifications (
          id, user_id, user_name, order_id, order_ref, customer_id, customer_name,
          notification_type, event, message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, (SELECT full_name FROM customers WHERE id = ?), 'status_update', ?, ?, NOW())`,
        // event is the new status: order.pending / order.in_production / order.ready / order.completed
        [notifId, userId, userName, id, order.soa_no, order.customer_id, order.customer_id, `order.${derivedStatus}`, detail]
      );
    }

    await conn.commit();

    // Fetch updated order with items to return and broadcast
    const fullOrder = await loadFullOrder(id);
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

// Locks the order row and returns it with the customer name, or null
async function lockOrder(conn, id) {
  const [rows] = await conn.query(
    `SELECT o.*, COALESCE(c.full_name, '') AS customerName
    FROM orders o
    LEFT JOIN customers c ON o.customer_id = c.id
    WHERE o.id = ? FOR UPDATE`,
    [id]
  );
  return rows[0] || null;
}

// Free-text reason for voids and cancellations: required, max 500 characters
function parseReason(body, action) {
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) return { error: `A reason is required to ${action}` };
  if (reason.length > 500) return { error: "Reason must be 500 characters or fewer" };
  return { reason };
}

// GET /api/orders/:id/payments
export async function getOrderPayments(req, res) {
  try {
    const order = await loadFullOrder(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });
    res.json(order.payments);
  } catch (err) {
    console.error("getOrderPayments error:", err);
    res.status(500).json({ message: "Failed to fetch payments" });
  }
}

// POST /api/orders/:id/payments
// Records a down payment, payment or EWT entry; the order's amount paid / balance / status follow from the log
export async function recordPayment(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;

    const order = await lockOrder(conn, id);
    if (!order) {
      await conn.rollback();
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.status === "cancelled") {
      await conn.rollback();
      return res.status(400).json({ message: "Payments can't be recorded on a cancelled order" });
    }

    const { fields, error } = parsePaymentInput(req.body, Number(order.balance));
    if (error) {
      await conn.rollback();
      return res.status(400).json({ message: error });
    }

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Staff";
    await insertPayment(conn, id, fields, userId);
    const after = await recalcOrderPayments(conn, id);

    // A finished order that was only waiting on payment completes once the balance is settled
    let statusNote = "";
    if (order.status === "ready" && after.balance === 0 && Number(order.overall_progress) >= 100) {
      await conn.query(
        "UPDATE orders SET status = 'completed', date_completed = COALESCE(date_completed, CURDATE()) WHERE id = ?",
        [id]
      );
      statusNote = " Order is now Completed.";
    }

    const label = `SOA ${order.soa_no}`;
    const detail = `${describePayment(fields)} recorded for ${label}. New balance: ${formatCurrency(after.balance)}.${statusNote}`;
    const notification = await insertNotification(conn, {
      userId,
      userName,
      order,
      customerName: order.customerName,
      type: "detail_update",
      event: fields.paymentType === "payment" ? "payment.record" : `payment.${fields.paymentType}`,
      detail,
    });

    await logAudit(conn, req, {
      action: "payment.record",
      category: "payment",
      entityType: "order",
      entityId: id,
      entityLabel: label,
      description: detail,
      changes: diffFields(
        { amountPaid: Number(order.amount_paid), balance: Number(order.balance), paymentStatus: order.payment_status },
        after,
        ["amountPaid", "balance", "paymentStatus"]
      ),
    });

    await conn.commit();

    const fullOrder = await loadFullOrder(id);
    emitOrderUpdated(fullOrder);
    emitNotification(notification);
    res.status(201).json(fullOrder);
  } catch (err) {
    await conn.rollback();
    console.error("recordPayment error:", err);
    res.status(500).json({ message: "Failed to record payment" });
  } finally {
    conn.release();
  }
}

// PATCH /api/orders/:id/payments/:paymentId/void (admin)
// Payments are never deleted; a voided entry stays visible but no longer counts
export async function voidPayment(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id, paymentId } = req.params;
    const { reason, error } = parseReason(req.body, "void a payment");
    if (error) {
      await conn.rollback();
      return res.status(400).json({ message: error });
    }

    const order = await lockOrder(conn, id);
    if (!order) {
      await conn.rollback();
      return res.status(404).json({ message: "Order not found" });
    }
    const [[payment]] = await conn.query(
      `SELECT payment_type AS paymentType, method, CAST(amount AS DOUBLE) AS amount,
        reference_no AS referenceNo, voided_at AS voidedAt
      FROM payments WHERE id = ? AND order_id = ? FOR UPDATE`,
      [paymentId, id]
    );
    if (!payment) {
      await conn.rollback();
      return res.status(404).json({ message: "Payment not found" });
    }
    if (payment.voidedAt) {
      await conn.rollback();
      return res.status(400).json({ message: "This payment is already voided" });
    }

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Admin";
    await conn.query("UPDATE payments SET voided_at = NOW(), voided_by = ?, void_reason = ? WHERE id = ?", [
      userId,
      reason,
      paymentId,
    ]);
    const after = await recalcOrderPayments(conn, id);

    const label = `SOA ${order.soa_no}`;
    const detail = `Voided ${describePayment(payment)} on ${label}: ${reason}. New balance: ${formatCurrency(after.balance)}`;
    const notification = await insertNotification(conn, {
      userId,
      userName,
      order,
      customerName: order.customerName,
      type: "detail_update",
      event: "payment.void",
      detail,
    });

    await logAudit(conn, req, {
      action: "payment.void",
      category: "payment",
      entityType: "order",
      entityId: id,
      entityLabel: label,
      description: detail,
      changes: diffFields(
        { amountPaid: Number(order.amount_paid), balance: Number(order.balance), paymentStatus: order.payment_status },
        after,
        ["amountPaid", "balance", "paymentStatus"]
      ),
    });

    await conn.commit();

    const fullOrder = await loadFullOrder(id);
    emitOrderUpdated(fullOrder);
    emitNotification(notification);
    res.json(fullOrder);
  } catch (err) {
    await conn.rollback();
    console.error("voidPayment error:", err);
    res.status(500).json({ message: "Failed to void payment" });
  } finally {
    conn.release();
  }
}

// POST /api/orders/:id/cancel (admin)
// The order and its SOA No stay on record as cancelled. Payments must be voided first so no money is left on it.
export async function cancelOrder(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { reason, error } = parseReason(req.body, "cancel an order");
    if (error) {
      await conn.rollback();
      return res.status(400).json({ message: error });
    }

    const order = await lockOrder(conn, id);
    if (!order) {
      await conn.rollback();
      return res.status(404).json({ message: "Order not found" });
    }
    if (order.status === "cancelled") {
      await conn.rollback();
      return res.status(400).json({ message: "This order is already cancelled" });
    }
    const [[{ activePayments }]] = await conn.query(
      "SELECT COUNT(*) AS activePayments FROM payments WHERE order_id = ? AND voided_at IS NULL",
      [id]
    );
    if (activePayments > 0) {
      await conn.rollback();
      return res.status(400).json({
        message: `This order still has ${activePayments} payment${activePayments === 1 ? "" : "s"} recorded. Void ${
          activePayments === 1 ? "it" : "them"
        } (refund the customer) before cancelling.`,
      });
    }

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Admin";
    await conn.query(
      "UPDATE orders SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ?, updated_by = ? WHERE id = ?",
      [userId, reason, userId, id]
    );

    const label = `SOA ${order.soa_no}`;
    const detail = `${label} was cancelled: ${reason}`;
    const notification = await insertNotification(conn, {
      userId,
      userName,
      order,
      customerName: order.customerName,
      type: "status_update",
      event: "order.cancel",
      detail,
    });

    await logAudit(conn, req, {
      action: "order.cancel",
      category: "order",
      entityType: "order",
      entityId: id,
      entityLabel: label,
      description: detail,
      changes: { status: { from: order.status, to: "cancelled" } },
    });

    await conn.commit();

    const fullOrder = await loadFullOrder(id);
    emitOrderUpdated(fullOrder);
    emitNotification(notification);
    res.json(fullOrder);
  } catch (err) {
    await conn.rollback();
    console.error("cancelOrder error:", err);
    res.status(500).json({ message: "Failed to cancel order" });
  } finally {
    conn.release();
  }
}
