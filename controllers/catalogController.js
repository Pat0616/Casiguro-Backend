// backend/controllers/catalogController.js
import pool from "../database/db.js";
import crypto from "crypto";

// GET /api/catalog
// Fetches catalog items. If employee or unauthenticated, filters to active only.
export async function getCatalogItems(req, res) {
  try {
    const isAdmin = req.user?.role === "admin";
    const { type, search, includeInactive } = req.query;

    let query = `
      SELECT
        p.id,
        p.name,
        p.type,
        CAST(p.base_price AS DOUBLE) AS basePrice,
        CAST(p.default_unit_price AS DOUBLE) AS defaultUnitPrice,
        p.description,
        p.is_stock_item AS isStockItem,
        p.is_active AS isActive,
        p.category_id AS categoryId,
        COALESCE(c.name, 'General') AS categoryName,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE 1=1
    `;
    const params = [];

    // Restrict inactive items unless user is admin and explicitly wants them
    if (!isAdmin || includeInactive !== "true") {
      query += ` AND p.is_active = TRUE`;
    }

    if (type && (type === "product" || type === "service")) {
      query += ` AND p.type = ?`;
      params.push(type);
    }

    if (search && search.trim()) {
      query += ` AND (p.name LIKE ? OR p.description LIKE ? OR c.name LIKE ?)`;
      const s = `%${search.trim()}%`;
      params.push(s, s, s);
    }

    query += ` ORDER BY p.type ASC, p.name ASC`;

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("getCatalogItems error:", err);
    res.status(500).json({ message: "Failed to fetch catalog items" });
  }
}

// POST /api/catalog (Admin only)
export async function createCatalogItem(req, res) {
  try {
    const {
      name,
      type = "product",
      basePrice = 0,
      description = "",
      categoryId = null,
      isStockItem = false,
      isActive = true,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Item name is required" });
    }

    if (type !== "product" && type !== "service") {
      return res.status(400).json({ message: "Type must be either 'product' or 'service'" });
    }

    const price = Math.max(0, Number(basePrice) || 0);
    const id = crypto.randomUUID();

    // Verify or resolve category
    let finalCategoryId = categoryId;
    if (typeof categoryId === "string" && categoryId.trim() && !categoryId.includes("-")) {
      // If client sent a category name rather than UUID
      const [catRows] = await pool.query("SELECT id FROM categories WHERE name = ?", [categoryId.trim()]);
      if (catRows.length > 0) {
        finalCategoryId = catRows[0].id;
      } else {
        finalCategoryId = crypto.randomUUID();
        await pool.query("INSERT INTO categories (id, name) VALUES (?, ?)", [finalCategoryId, categoryId.trim()]);
      }
    }

    await pool.query(
      `INSERT INTO products (
        id, category_id, type, name, base_price, default_unit_price, description, is_stock_item, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        finalCategoryId,
        type,
        name.trim(),
        price,
        price,
        description ? description.trim() : null,
        Boolean(isStockItem),
        Boolean(isActive),
      ]
    );

    const [createdRows] = await pool.query(
      `SELECT
        p.id,
        p.name,
        p.type,
        CAST(p.base_price AS DOUBLE) AS basePrice,
        CAST(p.default_unit_price AS DOUBLE) AS defaultUnitPrice,
        p.description,
        p.is_stock_item AS isStockItem,
        p.is_active AS isActive,
        p.category_id AS categoryId,
        COALESCE(c.name, 'General') AS categoryName
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?`,
      [id]
    );

    res.status(201).json(createdRows[0]);
  } catch (err) {
    console.error("createCatalogItem error:", err);
    res.status(500).json({ message: "Failed to create catalog item" });
  }
}

// PUT /api/catalog/:id (Admin only)
export async function updateCatalogItem(req, res) {
  try {
    const { id } = req.params;
    const {
      name,
      type,
      basePrice,
      description,
      categoryId,
      isStockItem,
      isActive,
    } = req.body;

    const [existing] = await pool.query("SELECT * FROM products WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Catalog item not found" });
    }

    const current = existing[0];
    const newName = name !== undefined ? name.trim() : current.name;
    const newType = type !== undefined ? type : current.type;
    const newPrice = basePrice !== undefined ? Math.max(0, Number(basePrice) || 0) : Number(current.base_price);
    const newDesc = description !== undefined ? description : current.description;
    const newStock = isStockItem !== undefined ? Boolean(isStockItem) : Boolean(current.is_stock_item);
    const newActive = isActive !== undefined ? Boolean(isActive) : Boolean(current.is_active);
    const newCatId = categoryId !== undefined ? categoryId : current.category_id;

    await pool.query(
      `UPDATE products SET
        name = ?,
        type = ?,
        base_price = ?,
        default_unit_price = ?,
        description = ?,
        category_id = ?,
        is_stock_item = ?,
        is_active = ?
      WHERE id = ?`,
      [
        newName,
        newType,
        newPrice,
        newPrice,
        newDesc,
        newCatId,
        newStock,
        newActive,
        id,
      ]
    );

    const [updatedRows] = await pool.query(
      `SELECT
        p.id,
        p.name,
        p.type,
        CAST(p.base_price AS DOUBLE) AS basePrice,
        CAST(p.default_unit_price AS DOUBLE) AS defaultUnitPrice,
        p.description,
        p.is_stock_item AS isStockItem,
        p.is_active AS isActive,
        p.category_id AS categoryId,
        COALESCE(c.name, 'General') AS categoryName
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?`,
      [id]
    );

    res.json(updatedRows[0]);
  } catch (err) {
    console.error("updateCatalogItem error:", err);
    res.status(500).json({ message: "Failed to update catalog item" });
  }
}

// PATCH /api/catalog/:id/status (Admin only)
export async function toggleCatalogItemStatus(req, res) {
  try {
    const { id } = req.params;
    const { isActive } = req.body;

    const [existing] = await pool.query("SELECT is_active FROM products WHERE id = ?", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Catalog item not found" });
    }

    const newActive = isActive !== undefined ? Boolean(isActive) : !existing[0].is_active;

    await pool.query("UPDATE products SET is_active = ? WHERE id = ?", [newActive, id]);
    res.json({ id, isActive: newActive, message: `Item marked as ${newActive ? "Active" : "Inactive"}` });
  } catch (err) {
    console.error("toggleCatalogItemStatus error:", err);
    res.status(500).json({ message: "Failed to toggle item status" });
  }
}

