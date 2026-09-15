// backend/controllers/quotationController.js
import pool from "../database/db.js";
import crypto from "crypto";
import { emitNotification, emitOrderCreated } from "../websocket/socket.js";

// Helper to auto-mark expired quotations
async function markExpiredQuotations() {
  try {
    await pool.query(
      "UPDATE quotations SET status = 'expired' WHERE status = 'sent' AND valid_until < CURDATE()"
    );
  } catch (err) {
    console.error("markExpiredQuotations error:", err);
  }
}

// GET /api/quotations
export async function getQuotations(req, res) {
  try {
    await markExpiredQuotations();

    const { status, search } = req.query;
    let query = `
      SELECT
        q.id,
        q.quote_no AS quoteNo,
        q.customer_id AS customerId,
        q.customer_name AS customerName,
        COALESCE(q.contact_number, '') AS contactNumber,
        q.status,
        q.valid_until AS validUntil,
        CAST(q.total_amount AS DOUBLE) AS totalAmount,
        COALESCE(q.notes, '') AS notes,
        COALESCE(q.rejection_reason, '') AS rejectionReason,
        COALESCE(u.full_name, 'Staff') AS createdBy,
        q.created_at AS createdAt,
        q.updated_at AS updatedAt,
        (SELECT o.id FROM orders o WHERE o.quotation_id = q.id LIMIT 1) AS convertedOrderId,
        (SELECT o.ref_no FROM orders o WHERE o.quotation_id = q.id LIMIT 1) AS convertedOrderRef
      FROM quotations q
      LEFT JOIN users u ON q.created_by = u.id
      WHERE 1=1
    `;
    const params = [];

    if (status && ["draft", "sent", "accepted", "rejected", "expired"].includes(status)) {
      query += ` AND q.status = ?`;
      params.push(status);
    }

    if (search && search.trim()) {
      query += ` AND (q.quote_no LIKE ? OR q.customer_name LIKE ? OR q.notes LIKE ?)`;
      const s = `%${search.trim()}%`;
      params.push(s, s, s);
    }

    query += ` ORDER BY q.created_at DESC`;

    const [quotes] = await pool.query(query, params);

    if (quotes.length === 0) {
      return res.json([]);
    }

    // Batch fetch all items for returned quotations
    const quoteIds = quotes.map((q) => q.id);
    const [items] = await pool.query(
      `SELECT
        qi.id,
        qi.quotation_id AS quotationId,
        qi.product_service_id AS productServiceId,
        qi.item_name_snapshot AS itemName,
        COALESCE(qi.item_description, '') AS itemDescription,
        COALESCE(qi.category_snapshot, 'General') AS category,
        qi.item_type AS itemType,
        qi.is_custom AS isCustom,
        qi.quantity,
        CAST(qi.base_price AS DOUBLE) AS basePrice,
        CAST(qi.final_unit_price AS DOUBLE) AS finalUnitPrice,
        qi.price_adjustment_reason AS priceAdjustmentReason,
        CAST(qi.subtotal AS DOUBLE) AS subtotal
      FROM quotation_items qi
      WHERE qi.quotation_id IN (?)
      ORDER BY qi.id ASC`,
      [quoteIds]
    );

    const itemsByQuoteId = {};
    for (const item of items) {
      if (!itemsByQuoteId[item.quotationId]) {
        itemsByQuoteId[item.quotationId] = [];
      }
      itemsByQuoteId[item.quotationId].push(item);
    }

    const result = quotes.map((q) => ({
      ...q,
      items: itemsByQuoteId[q.id] || [],
    }));

    res.json(result);
  } catch (err) {
    console.error("getQuotations error:", err);
    res.status(500).json({ message: "Failed to fetch quotations" });
  }
}

// GET /api/quotations/:id
export async function getQuotationById(req, res) {
  try {
    await markExpiredQuotations();
    const { id } = req.params;

    const [quotes] = await pool.query(
      `SELECT
        q.id,
        q.quote_no AS quoteNo,
        q.customer_id AS customerId,
        q.customer_name AS customerName,
        COALESCE(q.contact_number, '') AS contactNumber,
        q.status,
        q.valid_until AS validUntil,
        CAST(q.total_amount AS DOUBLE) AS totalAmount,
        COALESCE(q.notes, '') AS notes,
        COALESCE(q.rejection_reason, '') AS rejectionReason,
        COALESCE(u.full_name, 'Staff') AS createdBy,
        q.created_at AS createdAt,
        q.updated_at AS updatedAt,
        (SELECT o.id FROM orders o WHERE o.quotation_id = q.id LIMIT 1) AS convertedOrderId,
        (SELECT o.ref_no FROM orders o WHERE o.quotation_id = q.id LIMIT 1) AS convertedOrderRef
      FROM quotations q
      LEFT JOIN users u ON q.created_by = u.id
      WHERE q.id = ?`,
      [id]
    );

    if (quotes.length === 0) {
      return res.status(404).json({ message: "Quotation not found" });
    }

    const quote = quotes[0];
    const [items] = await pool.query(
      `SELECT
        qi.id,
        qi.quotation_id AS quotationId,
        qi.product_service_id AS productServiceId,
        qi.item_name_snapshot AS itemName,
        COALESCE(qi.item_description, '') AS itemDescription,
        COALESCE(qi.category_snapshot, 'General') AS category,
        qi.item_type AS itemType,
        qi.is_custom AS isCustom,
        qi.quantity,
        CAST(qi.base_price AS DOUBLE) AS basePrice,
        CAST(qi.final_unit_price AS DOUBLE) AS finalUnitPrice,
        qi.price_adjustment_reason AS priceAdjustmentReason,
        CAST(qi.subtotal AS DOUBLE) AS subtotal
      FROM quotation_items qi
      WHERE qi.quotation_id = ?`,
      [id]
    );

    res.json({ ...quote, items });
  } catch (err) {
    console.error("getQuotationById error:", err);
    res.status(500).json({ message: "Failed to fetch quotation" });
  }
}

// POST /api/quotations
export async function createQuotation(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const {
      customerName,
      contactNumber,
      validUntil,
      notes = "",
      items,
      status = "draft", // 'draft' or 'sent'
    } = req.body;

    if (!customerName || !customerName.trim()) {
      await conn.rollback();
      return res.status(400).json({ message: "Customer name is required" });
    }

    if (!validUntil) {
      await conn.rollback();
      return res.status(400).json({ message: "Quotation validity date (validUntil) is required" });
    }

    if (!Array.isArray(items) || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: "At least one item is required in the quotation" });
    }

    // Validate each item and check price adjustment rule
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.itemName || !item.itemName.trim()) {
        await conn.rollback();
        return res.status(400).json({ message: `Item #${i + 1} requires a valid item name` });
      }

      const qty = Number(item.quantity) || 0;
      if (qty <= 0) {
        await conn.rollback();
        return res.status(400).json({ message: `Item "${item.itemName}" must have a quantity of at least 1` });
      }

      const basePrice = Math.max(0, Number(item.basePrice) || 0);
      const finalUnitPrice = Math.max(0, Number(item.finalUnitPrice) || 0);

      // MANDATORY PRICE ADJUSTMENT VALIDATION
      if (Math.abs(finalUnitPrice - basePrice) > 0.001) {
        if (!item.priceAdjustmentReason || !item.priceAdjustmentReason.trim()) {
          await conn.rollback();
          return res.status(400).json({
            message: `A Price Adjustment Reason is strictly mandatory for item "${item.itemName}" because final price (₱${finalUnitPrice.toFixed(
              2
            )}) differs from catalog base price (₱${basePrice.toFixed(2)}).`,
          });
        }
      }
    }

    // 1. Resolve or upsert Customer
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

    // 2. Generate Quote Number QTN-YYYY-XXXX
    const year = new Date().getFullYear();
    const [countRows] = await conn.query("SELECT COUNT(*) AS total FROM quotations WHERE quote_no LIKE ?", [`QTN-${year}-%`]);
    const nextNum = (countRows[0]?.total || 0) + 1;
    let quoteNo = `QTN-${year}-${String(nextNum).padStart(4, "0")}`;
    const [existingQuote] = await conn.query("SELECT id FROM quotations WHERE quote_no = ?", [quoteNo]);
    if (existingQuote.length > 0) {
      quoteNo = `QTN-${year}-${String(nextNum + Math.floor(Math.random() * 1000)).padStart(4, "0")}`;
    }

    // 3. Compute total amount
    let totalAmount = 0;
    const preparedItems = items.map((item) => {
      const qty = Number(item.quantity) || 1;
      const basePrice = Math.max(0, Number(item.basePrice) || 0);
      const finalUnitPrice = Math.max(0, Number(item.finalUnitPrice) || 0);
      const subtotal = Number((qty * finalUnitPrice).toFixed(2));
      totalAmount += subtotal;

      return {
        id: crypto.randomUUID(),
        productServiceId: item.productServiceId || null,
        itemName: item.itemName.trim(),
        itemDescription: item.itemDescription ? item.itemDescription.trim() : null,
        category: item.category ? item.category.trim() : "General",
        itemType: item.itemType === "service" ? "service" : "product",
        isCustom: Boolean(item.isCustom),
        quantity: qty,
        basePrice,
        finalUnitPrice,
        priceAdjustmentReason: Math.abs(finalUnitPrice - basePrice) > 0.001 ? item.priceAdjustmentReason.trim() : null,
        subtotal,
      };
    });

    totalAmount = Number(totalAmount.toFixed(2));
    const quoteId = crypto.randomUUID();
    const userId = req.user?.id || null;
    const quoteStatus = status === "sent" ? "sent" : "draft";

    // 4. Insert Quotation
    await conn.query(
      `INSERT INTO quotations (
        id, quote_no, customer_id, customer_name, contact_number,
        status, valid_until, total_amount, notes, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quoteId,
        quoteNo,
        customerId,
        customerName.trim(),
        contactNumber ? contactNumber.trim() : null,
        quoteStatus,
        validUntil,
        totalAmount,
        notes ? notes.trim() : null,
        userId,
      ]
    );

    // 5. Insert Quotation Items
    for (const item of preparedItems) {
      await conn.query(
        `INSERT INTO quotation_items (
          id, quotation_id, product_service_id, item_name_snapshot,
          item_description, category_snapshot, item_type, is_custom,
          quantity, base_price, final_unit_price, price_adjustment_reason, subtotal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          quoteId,
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
        ]
      );
    }

    await conn.commit();

    const createdQuotation = {
      id: quoteId,
      quoteNo,
      customerId,
      customerName: customerName.trim(),
      contactNumber: contactNumber ? contactNumber.trim() : "",
      status: quoteStatus,
      validUntil,
      totalAmount,
      notes: notes ? notes.trim() : "",
      rejectionReason: "",
      createdBy: req.user?.full_name || "Staff",
      createdAt: new Date(),
      updatedAt: new Date(),
      items: preparedItems,
    };

    res.status(201).json(createdQuotation);
  } catch (err) {
    await conn.rollback();
    console.error("createQuotation error:", err);
    res.status(500).json({ message: "Failed to create quotation" });
  } finally {
    conn.release();
  }
}

// PUT /api/quotations/:id (Edit & Resend)
export async function updateQuotation(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;

    // 1. Fetch current quotation
    const [existing] = await conn.query("SELECT * FROM quotations WHERE id = ? FOR UPDATE", [id]);
    if (existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Quotation not found" });
    }

    const current = existing[0];
    if (current.status === "accepted") {
      await conn.rollback();
      return res.status(400).json({ message: "Accepted quotations are locked and cannot be edited" });
    }

    const {
      customerName = current.customer_name,
      contactNumber = current.contact_number,
      validUntil = current.valid_until,
      notes = current.notes,
      items,
      status,
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: "At least one item is required" });
    }

    // Validate each item and check price adjustment rule
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.itemName || !item.itemName.trim()) {
        await conn.rollback();
        return res.status(400).json({ message: `Item #${i + 1} requires an item name` });
      }

      const qty = Number(item.quantity) || 0;
      if (qty <= 0) {
        await conn.rollback();
        return res.status(400).json({ message: `Item "${item.itemName}" must have a quantity of at least 1` });
      }

      const basePrice = Math.max(0, Number(item.basePrice) || 0);
      const finalUnitPrice = Math.max(0, Number(item.finalUnitPrice) || 0);

      // MANDATORY PRICE ADJUSTMENT VALIDATION
      if (Math.abs(finalUnitPrice - basePrice) > 0.001) {
        if (!item.priceAdjustmentReason || !item.priceAdjustmentReason.trim()) {
          await conn.rollback();
          return res.status(400).json({
            message: `A Price Adjustment Reason is strictly mandatory for item "${item.itemName}" because final price (₱${finalUnitPrice.toFixed(
              2
            )}) differs from catalog base price (₱${basePrice.toFixed(2)}).`,
          });
        }
      }
    }

    let totalAmount = 0;
    const preparedItems = items.map((item) => {
      const qty = Number(item.quantity) || 1;
      const basePrice = Math.max(0, Number(item.basePrice) || 0);
      const finalUnitPrice = Math.max(0, Number(item.finalUnitPrice) || 0);
      const subtotal = Number((qty * finalUnitPrice).toFixed(2));
      totalAmount += subtotal;

      return {
        id: item.id || crypto.randomUUID(),
        productServiceId: item.productServiceId || null,
        itemName: item.itemName.trim(),
        itemDescription: item.itemDescription ? item.itemDescription.trim() : null,
        category: item.category ? item.category.trim() : "General",
        itemType: item.itemType === "service" ? "service" : "product",
        isCustom: Boolean(item.isCustom),
        quantity: qty,
        basePrice,
        finalUnitPrice,
        priceAdjustmentReason: Math.abs(finalUnitPrice - basePrice) > 0.001 ? item.priceAdjustmentReason.trim() : null,
        subtotal,
      };
    });

    totalAmount = Number(totalAmount.toFixed(2));
    const newStatus = status || (current.status === "rejected" ? "draft" : current.status);

    // 2. Update Quotation
    await conn.query(
      `UPDATE quotations SET
        customer_name = ?,
        contact_number = ?,
        valid_until = ?,
        notes = ?,
        total_amount = ?,
        status = ?,
        updated_by = ?
      WHERE id = ?`,
      [
        customerName.trim(),
        contactNumber ? contactNumber.trim() : null,
        validUntil,
        notes ? notes.trim() : null,
        totalAmount,
        newStatus,
        req.user?.id || null,
        id,
      ]
    );

    // 3. Delete old items and insert new
    await conn.query("DELETE FROM quotation_items WHERE quotation_id = ?", [id]);

    for (const item of preparedItems) {
      await conn.query(
        `INSERT INTO quotation_items (
          id, quotation_id, product_service_id, item_name_snapshot,
          item_description, category_snapshot, item_type, is_custom,
          quantity, base_price, final_unit_price, price_adjustment_reason, subtotal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          id,
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
        ]
      );
    }

    await conn.commit();

    res.json({
      id,
      quoteNo: current.quote_no,
      customerName: customerName.trim(),
      contactNumber: contactNumber ? contactNumber.trim() : "",
      status: newStatus,
      validUntil,
      totalAmount,
      notes: notes ? notes.trim() : "",
      items: preparedItems,
    });
  } catch (err) {
    await conn.rollback();
    console.error("updateQuotation error:", err);
    res.status(500).json({ message: "Failed to update quotation" });
  } finally {
    conn.release();
  }
}

// PATCH /api/quotations/:id/status
export async function updateQuotationStatus(req, res) {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    if (!["draft", "sent", "rejected", "expired"].includes(status)) {
      return res.status(400).json({ message: "Invalid status transition" });
    }

    const [existing] = await pool.query("SELECT * FROM quotations WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Quotation not found" });
    }

    if (existing[0].status === "accepted") {
      return res.status(400).json({ message: "Accepted quotations cannot change status" });
    }

    await pool.query(
      `UPDATE quotations SET
        status = ?,
        rejection_reason = ?,
        updated_by = ?
      WHERE id = ?`,
      [status, status === "rejected" ? rejectionReason || null : null, req.user?.id || null, id]
    );

    res.json({ id, status, message: `Quotation marked as ${status}` });
  } catch (err) {
    console.error("updateQuotationStatus error:", err);
    res.status(500).json({ message: "Failed to update status" });
  }
}

// POST /api/quotations/:id/accept-and-convert
// ATOMIC CONVERSION TO OPERATIONAL TRANSACTION (ORDER)
export async function acceptAndConvertToOrder(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;
    const { dueDate: rawDueDate, notes: orderNotes } = req.body;

    // 1. Fetch quote FOR UPDATE to lock record
    const [quoteRows] = await conn.query("SELECT * FROM quotations WHERE id = ? FOR UPDATE", [id]);
    if (quoteRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ message: "Quotation not found" });
    }

    const quote = quoteRows[0];
    if (quote.status === "accepted") {
      await conn.rollback();
      return res.status(400).json({ message: "This quotation has already been accepted and converted" });
    }

    if (quote.status === "expired") {
      await conn.rollback();
      return res.status(400).json({ message: "Cannot convert an expired quotation" });
    }

    // 2. Fetch line items
    const [items] = await conn.query("SELECT * FROM quotation_items WHERE quotation_id = ?", [id]);
    if (items.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: "Cannot convert a quotation with no items" });
    }

    // 3. Mark Quotation as accepted
    await conn.query(
      "UPDATE quotations SET status = 'accepted', updated_by = ? WHERE id = ?",
      [req.user?.id || null, id]
    );

    // 4. Generate Order Reference Number TXN-YYYY-XXXX
    const year = new Date().getFullYear();
    const [countRows] = await conn.query("SELECT COUNT(*) AS total FROM orders WHERE ref_no LIKE ?", [`TXN-${year}-%`]);
    const nextNum = (countRows[0]?.total || 0) + 1;
    let refNo = `TXN-${year}-${String(nextNum).padStart(4, "0")}`;
    const [existingRef] = await conn.query("SELECT id FROM orders WHERE ref_no = ?", [refNo]);
    if (existingRef.length > 0) {
      refNo = `TXN-${year}-${String(nextNum + Math.floor(Math.random() * 1000)).padStart(4, "0")}`;
    }

    // 5. Compute order values
    const orderId = crypto.randomUUID();
    const totalAmount = items.reduce((sum, it) => sum + Number(it.subtotal), 0);
    const totalQuantity = items.reduce((sum, it) => sum + Number(it.quantity), 0);
    const primaryItemName = items.map((i) => i.item_name_snapshot).join(", ").slice(0, 150);
    const primaryCategory = items[0]?.category_snapshot || "General";
    const todayStr = new Date().toISOString().slice(0, 10);
    const dueDate = rawDueDate || (quote.valid_until ? new Date(quote.valid_until).toISOString().slice(0, 10) : todayStr);

    const userId = req.user?.id || null;
    const userName = req.user?.full_name || "Employee";

    // 6. Insert Order
    await conn.query(
      `INSERT INTO orders (
        id, ref_no, quotation_id, customer_id, product_name_snapshot,
        order_type, quantity, quantity_completed, overall_progress,
        unit_price, total_price, amount_paid, balance,
        payment_status, status, notes, date_ordered, due_date, created_by
      ) VALUES (?, ?, ?, ?, ?, 'custom', ?, 0, 0, ?, ?, 0.00, ?, 'unpaid', 'pending', ?, ?, ?, ?)`,
      [
        orderId,
        refNo,
        quote.id,
        quote.customer_id,
        primaryItemName,
        totalQuantity,
        items[0]?.final_unit_price || 0,
        totalAmount,
        totalAmount,
        orderNotes || quote.notes || `Converted from quotation ${quote.quote_no}`,
        todayStr,
        dueDate,
        userId,
      ]
    );

    // 7. Insert Order Items with pricing snapshots
    const orderItems = [];
    for (const it of items) {
      const orderItemId = crypto.randomUUID();
      await conn.query(
        `INSERT INTO order_items (
          id, order_id, product_service_id, item_name_snapshot,
          item_description, category_snapshot, item_type, is_custom,
          quantity, base_price, final_unit_price, price_adjustment_reason,
          subtotal, quantity_completed, production_progress, production_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'pending')`,
        [
          orderItemId,
          orderId,
          it.product_service_id,
          it.item_name_snapshot,
          it.item_description,
          it.category_snapshot,
          it.item_type,
          it.is_custom,
          it.quantity,
          it.base_price,
          it.final_unit_price,
          it.price_adjustment_reason,
          it.subtotal,
        ]
      );

      orderItems.push({
        id: orderItemId,
        orderId,
        productServiceId: it.product_service_id,
        itemName: it.item_name_snapshot,
        itemDescription: it.item_description || "",
        category: it.category_snapshot || "General",
        itemType: it.item_type,
        isCustom: Boolean(it.is_custom),
        quantity: it.quantity,
        basePrice: Number(it.base_price),
        finalUnitPrice: Number(it.final_unit_price),
        priceAdjustmentReason: it.price_adjustment_reason || null,
        subtotal: Number(it.subtotal),
        quantityCompleted: 0,
        productionProgress: 0,
        productionStatus: "pending",
      });
    }

    // 8. Create Notification
    const notifId = crypto.randomUUID();
    const notifDetail = `Quotation ${quote.quote_no} accepted and converted to Order ${refNo} (Total: ₱${totalAmount.toLocaleString(
      "en-PH",
      { minimumFractionDigits: 2 }
    )})`;
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
        quote.customer_id,
        quote.customer_name,
        notifDetail,
        now,
      ]
    );

    await conn.commit();

    const createdOrder = {
      id: orderId,
      refNo,
      quotationId: quote.id,
      customerName: quote.customer_name,
      contactNumber: quote.contact_number || "",
      product: primaryItemName,
      category: primaryCategory,
      orderType: "custom",
      quantity: totalQuantity,
      quantityCompleted: 0,
      overallProgress: 0,
      unitPrice: items[0]?.final_unit_price || 0,
      totalPrice: totalAmount,
      amountPaid: 0,
      balance: totalAmount,
      paymentStatus: "unpaid",
      status: "pending",
      notes: orderNotes || quote.notes || "",
      dateOrdered: todayStr,
      dueDate,
      items: orderItems,
    };

    const createdNotif = {
      id: notifId,
      type: "new_order",
      user: userName,
      orderRef: refNo,
      customerName: quote.customer_name,
      detail: notifDetail,
      timestamp: now,
      readAt: null,
    };

    // Real-time broadcasts
    emitOrderCreated(createdOrder);
    emitNotification(createdNotif);

    res.status(201).json({
      message: "Quotation accepted and order created successfully",
      order: createdOrder,
    });
  } catch (err) {
    await conn.rollback();
    console.error("acceptAndConvertToOrder error:", err);
    res.status(500).json({ message: "Failed to convert quotation to order" });
  } finally {
    conn.release();
  }
}

