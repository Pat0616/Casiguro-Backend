// backend/scripts/migrate_multi_item.js
import mysql from "mysql2/promise";
import crypto from "crypto";

async function runMigration() {
  const connection = await mysql.createConnection({
    host: "127.0.0.1",
    user: "root",
    password: "",
    database: "casigurotest",
    multipleStatements: true,
  });

  console.log("Connected to MySQL casigurotest...");

  try {
    // 1. Alter products table
    console.log("Checking and altering products table...");
    const [prodCols] = await connection.query("DESCRIBE products;");
    const prodColNames = prodCols.map((c) => c.Field);

    if (!prodColNames.includes("type")) {
      await connection.query("ALTER TABLE products ADD COLUMN type ENUM('product', 'service') NOT NULL DEFAULT 'product' AFTER category_id;");
      console.log("Added type column to products.");
    }
    if (!prodColNames.includes("base_price")) {
      await connection.query("ALTER TABLE products ADD COLUMN base_price DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER name;");
      await connection.query("UPDATE products SET base_price = default_unit_price WHERE base_price = 0.00;");
      console.log("Added base_price column to products and populated from default_unit_price.");
    }
    if (!prodColNames.includes("description")) {
      await connection.query("ALTER TABLE products ADD COLUMN description TEXT NULL AFTER base_price;");
      console.log("Added description column to products.");
    }
    if (!prodColNames.includes("is_active")) {
      await connection.query("ALTER TABLE products ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE AFTER is_stock_item;");
      console.log("Added is_active column to products.");
    }

    // 2. Create quotations table
    console.log("Creating quotations table...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS quotations (
        id CHAR(36) PRIMARY KEY,
        quote_no VARCHAR(50) UNIQUE NOT NULL,
        customer_id CHAR(36) NULL,
        customer_name VARCHAR(150) NOT NULL,
        contact_number VARCHAR(50) NULL,
        status ENUM('draft', 'sent', 'accepted', 'rejected', 'expired') NOT NULL DEFAULT 'draft',
        valid_until DATE NOT NULL,
        total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        notes TEXT NULL,
        rejection_reason TEXT NULL,
        created_by CHAR(36) NULL,
        updated_by CHAR(36) NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

        CONSTRAINT fk_quotations_customer
          FOREIGN KEY (customer_id)
          REFERENCES customers(id)
          ON DELETE SET NULL
          ON UPDATE CASCADE,

        CONSTRAINT fk_quotations_created_by
          FOREIGN KEY (created_by)
          REFERENCES users(id)
          ON DELETE SET NULL
          ON UPDATE CASCADE,

        CONSTRAINT fk_quotations_updated_by
          FOREIGN KEY (updated_by)
          REFERENCES users(id)
          ON DELETE SET NULL
          ON UPDATE CASCADE,

        INDEX idx_quotations_quote_no (quote_no),
        INDEX idx_quotations_status (status),
        INDEX idx_quotations_valid_until (valid_until),
        INDEX idx_quotations_created_at (created_at DESC)
      ) ENGINE=InnoDB;
    `);

    // 3. Create quotation_items table
    console.log("Creating quotation_items table...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS quotation_items (
        id CHAR(36) PRIMARY KEY,
        quotation_id CHAR(36) NOT NULL,
        product_service_id CHAR(36) NULL,
        item_name_snapshot VARCHAR(150) NOT NULL,
        item_description TEXT NULL,
        category_snapshot VARCHAR(100) NULL,
        item_type ENUM('product', 'service') NOT NULL DEFAULT 'product',
        is_custom BOOLEAN NOT NULL DEFAULT FALSE,
        quantity INT NOT NULL DEFAULT 1,
        base_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        final_unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        price_adjustment_reason TEXT NULL,
        subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,

        CONSTRAINT fk_quotation_items_quotation
          FOREIGN KEY (quotation_id)
          REFERENCES quotations(id)
          ON DELETE CASCADE
          ON UPDATE CASCADE,

        CONSTRAINT fk_quotation_items_product
          FOREIGN KEY (product_service_id)
          REFERENCES products(id)
          ON DELETE SET NULL
          ON UPDATE CASCADE,

        INDEX idx_quotation_items_quotation_id (quotation_id)
      ) ENGINE=InnoDB;
    `);

    // 4. Alter orders table
    console.log("Checking and altering orders table...");
    const [orderCols] = await connection.query("DESCRIBE orders;");
    const orderColNames = orderCols.map((c) => c.Field);

    if (!orderColNames.includes("quotation_id")) {
      await connection.query("ALTER TABLE orders ADD COLUMN quotation_id CHAR(36) NULL AFTER ref_no;");
      await connection.query(`
        ALTER TABLE orders
        ADD CONSTRAINT fk_orders_quotation
        FOREIGN KEY (quotation_id) REFERENCES quotations(id)
        ON DELETE SET NULL ON UPDATE CASCADE;
      `);
      console.log("Added quotation_id column and foreign key to orders.");
    }

    if (!orderColNames.includes("overall_progress")) {
      await connection.query("ALTER TABLE orders ADD COLUMN overall_progress INT NOT NULL DEFAULT 0 AFTER quantity_completed;");
      console.log("Added overall_progress column to orders.");
    }

    // 5. Create order_items table
    console.log("Creating order_items table...");
    await connection.query(`
      CREATE TABLE IF NOT EXISTS order_items (
        id CHAR(36) PRIMARY KEY,
        order_id CHAR(36) NOT NULL,
        product_service_id CHAR(36) NULL,
        item_name_snapshot VARCHAR(150) NOT NULL,
        item_description TEXT NULL,
        category_snapshot VARCHAR(100) NULL,
        item_type ENUM('product', 'service') NOT NULL DEFAULT 'product',
        is_custom BOOLEAN NOT NULL DEFAULT FALSE,
        quantity INT NOT NULL DEFAULT 1,
        base_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        final_unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        price_adjustment_reason TEXT NULL,
        subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        quantity_completed INT NOT NULL DEFAULT 0,
        production_progress INT NOT NULL DEFAULT 0,
        production_status ENUM('pending', 'in_production', 'completed') NOT NULL DEFAULT 'pending',

        CONSTRAINT fk_order_items_order
          FOREIGN KEY (order_id)
          REFERENCES orders(id)
          ON DELETE CASCADE
          ON UPDATE CASCADE,

        CONSTRAINT fk_order_items_product
          FOREIGN KEY (product_service_id)
          REFERENCES products(id)
          ON DELETE SET NULL
          ON UPDATE CASCADE,

        INDEX idx_order_items_order_id (order_id)
      ) ENGINE=InnoDB;
    `);

    // 6. Migrate existing orders
    console.log("Checking if existing orders need migration to order_items...");
    const [existingOrders] = await connection.query(`
      SELECT o.*, c.full_name AS customer_full_name, c.contact_number AS customer_contact, cat.name AS category_name
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      LEFT JOIN categories cat ON o.category_id = cat.id
    `);

    let migratedCount = 0;
    for (const order of existingOrders) {
      // Check if order already has items
      const [items] = await connection.query("SELECT id FROM order_items WHERE order_id = ?", [order.id]);
      if (items.length === 0) {
        const orderItemId = crypto.randomUUID();
        const quoteId = order.quotation_id || crypto.randomUUID();
        const quoteItemId = crypto.randomUUID();

        const qty = Number(order.quantity) || 1;
        const qtyCompleted = Number(order.quantity_completed) || 0;
        const unitPrice = Number(order.unit_price) || 0;
        const subtotal = Number(order.total_price) || (qty * unitPrice);
        const itemProgress = qty > 0 ? Math.min(100, Math.round((qtyCompleted / qty) * 100)) : 0;
        let itemProdStatus = "pending";
        if (order.status === "completed" || itemProgress >= 100) {
          itemProdStatus = "completed";
        } else if (itemProgress > 0 || order.status === "in_production") {
          itemProdStatus = "in_production";
        }

        // 6a. Create historical quotation if not exists
        const [existingQuote] = await connection.query("SELECT id FROM quotations WHERE id = ?", [quoteId]);
        if (existingQuote.length === 0) {
          const year = order.date_ordered ? new Date(order.date_ordered).getFullYear() : 2026;
          const cleanRef = (order.ref_no || "").replace("TXN-", "");
          const quoteNo = `QTN-${cleanRef || crypto.randomUUID().slice(0, 8).toUpperCase()}`;

          await connection.query(`
            INSERT INTO quotations (
              id, quote_no, customer_id, customer_name, contact_number,
              status, valid_until, total_amount, notes, created_by, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?)
          `, [
            quoteId,
            quoteNo,
            order.customer_id,
            order.customer_full_name || "Valued Customer",
            order.customer_contact || null,
            order.due_date || order.date_ordered || new Date(),
            subtotal,
            order.notes || "Migrated historical quotation",
            order.created_by || null,
            order.created_at || new Date(),
            order.updated_at || new Date()
          ]);

          // Insert quotation item
          await connection.query(`
            INSERT INTO quotation_items (
              id, quotation_id, product_service_id, item_name_snapshot,
              item_description, category_snapshot, item_type, is_custom,
              quantity, base_price, final_unit_price, price_adjustment_reason, subtotal
            ) VALUES (?, ?, ?, ?, ?, ?, 'product', ?, ?, ?, ?, NULL, ?)
          `, [
            quoteItemId,
            quoteId,
            order.product_id || null,
            order.product_name_snapshot || "Printing Service",
            order.notes || null,
            order.category_name || "General",
            order.order_type === "custom",
            qty,
            unitPrice,
            unitPrice,
            subtotal
          ]);
        }

        // 6b. Insert order item
        await connection.query(`
          INSERT INTO order_items (
            id, order_id, product_service_id, item_name_snapshot,
            item_description, category_snapshot, item_type, is_custom,
            quantity, base_price, final_unit_price, price_adjustment_reason,
            subtotal, quantity_completed, production_progress, production_status
          ) VALUES (?, ?, ?, ?, ?, ?, 'product', ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        `, [
          orderItemId,
          order.id,
          order.product_id || null,
          order.product_name_snapshot || "Printing Service",
          order.notes || null,
          order.category_name || "General",
          order.order_type === "custom",
          qty,
          unitPrice,
          unitPrice,
          subtotal,
          qtyCompleted,
          itemProgress,
          itemProdStatus
        ]);

        // 6c. Update order quotation_id & overall_progress
        await connection.query(`
          UPDATE orders
          SET quotation_id = ?, overall_progress = ?
          WHERE id = ?
        `, [quoteId, itemProgress, order.id]);

        migratedCount++;
      }
    }

    console.log(`Migration completed successfully! Migrated ${migratedCount} orders to order_items and quotations.`);
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  } finally {
    await connection.end();
  }
}

runMigration();
