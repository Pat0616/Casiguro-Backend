import pool from "../database/db.js";

async function migrateCatalogImages() {
  try {
    const [columns] = await pool.query("SHOW COLUMNS FROM products LIKE 'image_url'");
    if (columns.length === 0) {
      await pool.query("ALTER TABLE products ADD COLUMN image_url TEXT NULL AFTER description");
      console.log("Added image_url to products.");
    } else {
      console.log("products.image_url already exists.");
    }
  } catch (error) {
    console.error("Failed to add catalog image support:", error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrateCatalogImages();
