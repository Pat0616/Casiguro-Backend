// backend/controllers/categoryController.js
// Product & service categories, managed from their own section of the Catalog page. Categories are only created here
// (product saves and orders no longer create them on the fly). A fresh install starts with none.
import pool from "../database/db.js";
import crypto from "crypto";
import { diffFields, logAudit } from "../utils/auditLog.js";

const MAX_NAME = 100; // categories.name VARCHAR(100)
const MAX_DESCRIPTION = 500;

const SELECT_CATEGORIES = `
  SELECT
    c.id,
    c.name,
    c.description,
    c.created_at AS createdAt,
    (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS productCount,
    (SELECT COUNT(*) FROM orders o WHERE o.category_id = c.id) AS orderCount
  FROM categories c
`;

function toCategory(row) {
  return { ...row, productCount: Number(row.productCount), orderCount: Number(row.orderCount) };
}

// { name, description } from the body, or { error }
function parseCategoryInput(body) {
  const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
  if (!name) return { error: "Category name is required" };
  if (name.length > MAX_NAME) return { error: `Category name must be ${MAX_NAME} characters or fewer` };
  const description = typeof body?.description === "string" ? body.description.trim() : "";
  if (description.length > MAX_DESCRIPTION) return { error: `Description must be ${MAX_DESCRIPTION} characters or fewer` };
  return { name, description: description || null };
}

// The name column's collation is case-insensitive, so "apparel" matches "Apparel"
async function nameTaken(name, exceptId = null) {
  const [rows] = await pool.query("SELECT id FROM categories WHERE name = ? AND id <> ?", [name, exceptId || ""]);
  return rows.length > 0;
}

async function fetchCategory(id) {
  const [rows] = await pool.query(`${SELECT_CATEGORIES} WHERE c.id = ?`, [id]);
  return rows[0] ? toCategory(rows[0]) : null;
}

// GET /api/categories (any signed-in user: custom order/quotation lines pick from this list)
export async function getCategories(req, res) {
  try {
    const [rows] = await pool.query(`${SELECT_CATEGORIES} ORDER BY c.name ASC`);
    res.json(rows.map(toCategory));
  } catch (err) {
    console.error("getCategories error:", err);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
}

// POST /api/categories (admin)
export async function createCategory(req, res) {
  try {
    const input = parseCategoryInput(req.body);
    if (input.error) return res.status(400).json({ message: input.error });
    if (await nameTaken(input.name)) {
      return res.status(409).json({ message: `A category named "${input.name}" already exists` });
    }

    const id = crypto.randomUUID();
    await pool.query("INSERT INTO categories (id, name, description) VALUES (?, ?, ?)", [id, input.name, input.description]);
    await logAudit(pool, req, {
      action: "catalog.category_create",
      category: "catalog",
      entityType: "category",
      entityId: id,
      entityLabel: input.name,
      description: `Created category "${input.name}"`,
    });

    res.status(201).json(await fetchCategory(id));
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "A category with that name already exists" });
    console.error("createCategory error:", err);
    res.status(500).json({ message: "Failed to create category" });
  }
}

// PUT /api/categories/:id (admin). Renaming updates every product in it; saved order/quotation lines keep their old text.
export async function updateCategory(req, res) {
  try {
    const { id } = req.params;
    const [existing] = await pool.query("SELECT name, description FROM categories WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ message: "Category not found" });

    const input = parseCategoryInput(req.body);
    if (input.error) return res.status(400).json({ message: input.error });
    if (req.body?.description === undefined) input.description = existing[0].description; // not sent: keep it
    if (await nameTaken(input.name, id)) {
      return res.status(409).json({ message: `A category named "${input.name}" already exists` });
    }

    await pool.query("UPDATE categories SET name = ?, description = ? WHERE id = ?", [input.name, input.description, id]);
    const changes = diffFields(existing[0], input, ["name", "description"]);
    if (changes) {
      await logAudit(pool, req, {
        action: "catalog.category_update",
        category: "catalog",
        entityType: "category",
        entityId: id,
        entityLabel: input.name,
        description: changes.name
          ? `Renamed category "${existing[0].name}" to "${input.name}"`
          : `Edited category "${input.name}" (description)`,
        changes,
      });
    }

    res.json(await fetchCategory(id));
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "A category with that name already exists" });
    console.error("updateCategory error:", err);
    res.status(500).json({ message: "Failed to update category" });
  }
}

// DELETE /api/categories/:id (admin). Refused while products or orders still use it, so nothing silently loses its category.
export async function deleteCategory(req, res) {
  try {
    const category = await fetchCategory(req.params.id);
    if (!category) return res.status(404).json({ message: "Category not found" });

    if (category.productCount > 0 || category.orderCount > 0) {
      const uses = [
        category.productCount > 0 && `${category.productCount} catalog item${category.productCount === 1 ? "" : "s"}`,
        category.orderCount > 0 && `${category.orderCount} order${category.orderCount === 1 ? "" : "s"}`,
      ].filter(Boolean).join(" and ");
      const advice = category.productCount > 0
        ? "Move those items to another category first."
        : "Orders keep their category, so it can't be deleted. You can rename it instead.";
      return res.status(409).json({ message: `"${category.name}" is used by ${uses}. ${advice}` });
    }

    await pool.query("DELETE FROM categories WHERE id = ?", [category.id]);
    await logAudit(pool, req, {
      action: "catalog.category_delete",
      category: "catalog",
      entityType: "category",
      entityId: category.id,
      entityLabel: category.name,
      description: `Deleted category "${category.name}"`,
    });

    res.json({ id: category.id, message: "Category deleted" });
  } catch (err) {
    console.error("deleteCategory error:", err);
    res.status(500).json({ message: "Failed to delete category" });
  }
}
