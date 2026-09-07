-- ========================================================
-- CASIGURO ENTERPRISES TRANSACTION MANAGEMENT SYSTEM SCHEMA
-- Database: casigurotest (or your_database)
-- Character Set: utf8mb4 / utf8mb4_unicode_ci
-- ========================================================

CREATE DATABASE IF NOT EXISTS casigurotest
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE casigurotest;

-- ========================================================
-- 1. USERS (Admin & Employee accounts for RBAC)
-- ========================================================
CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'employee',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT chk_users_role CHECK (role IN ('admin', 'employee'))
) ENGINE=InnoDB;

-- ========================================================
-- 2. CUSTOMERS (Directory, contact info, and balance history)
-- ========================================================
CREATE TABLE IF NOT EXISTS customers (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  full_name VARCHAR(150) NOT NULL,
  contact_number VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_customers_name (full_name)
) ENGINE=InnoDB;

-- ========================================================
-- 3. CATEGORIES (Product classifications)
-- ========================================================
CREATE TABLE IF NOT EXISTS categories (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ========================================================
-- 4. PRODUCTS (Catalog items & base pricing)
-- ========================================================
CREATE TABLE IF NOT EXISTS products (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  category_id CHAR(36),
  name VARCHAR(150) NOT NULL,
  default_unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  is_stock_item BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_products_category
    FOREIGN KEY (category_id)
    REFERENCES categories(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  INDEX idx_products_name (name)
) ENGINE=InnoDB;

-- ========================================================
-- 5. ORDERS (Transactions, production state, and financials)
-- ========================================================
CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  ref_no VARCHAR(50) UNIQUE NOT NULL,

  customer_id CHAR(36),
  product_id CHAR(36),
  category_id CHAR(36),

  product_name_snapshot VARCHAR(150) NOT NULL,

  order_type VARCHAR(20) NOT NULL DEFAULT 'custom',
  quantity INT NOT NULL DEFAULT 1,
  quantity_completed INT NOT NULL DEFAULT 0,

  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,

  payment_status VARCHAR(20) NOT NULL DEFAULT 'unpaid',
  status VARCHAR(30) NOT NULL DEFAULT 'pending',

  notes TEXT,

  date_ordered DATE NOT NULL,
  due_date DATE,
  date_completed DATE,

  created_by CHAR(36),
  updated_by CHAR(36),

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT chk_orders_order_type
    CHECK (order_type IN ('custom', 'stock')),

  CONSTRAINT chk_orders_quantity
    CHECK (quantity >= 0),

  CONSTRAINT chk_orders_quantity_completed
    CHECK (quantity_completed >= 0),

  CONSTRAINT chk_orders_payment_status
    CHECK (payment_status IN ('unpaid', 'partial', 'paid')),

  CONSTRAINT chk_orders_status
    CHECK (status IN ('pending', 'in_production', 'ready', 'completed')),

  CONSTRAINT fk_orders_customer
    FOREIGN KEY (customer_id)
    REFERENCES customers(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_orders_product
    FOREIGN KEY (product_id)
    REFERENCES products(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_orders_category
    FOREIGN KEY (category_id)
    REFERENCES categories(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_orders_created_by
    FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_orders_updated_by
    FOREIGN KEY (updated_by)
    REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  INDEX idx_orders_ref_no (ref_no),
  INDEX idx_orders_status (status),
  INDEX idx_orders_payment_status (payment_status),
  INDEX idx_orders_due_date (due_date),
  INDEX idx_orders_date_ordered (date_ordered),
  INDEX idx_orders_date_completed (date_completed)
) ENGINE=InnoDB;

-- ========================================================
-- 6. NOTIFICATIONS (Persistent activity log for offline & online RTC)
-- ========================================================
CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),

  user_id CHAR(36),
  user_name VARCHAR(150),
  order_id CHAR(36),
  order_ref VARCHAR(50),
  customer_id CHAR(36),
  customer_name VARCHAR(150),

  notification_type VARCHAR(50) NOT NULL,
  message TEXT NOT NULL,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TIMESTAMP NULL,

  CONSTRAINT chk_notifications_type
    CHECK (
      notification_type IN (
        'new_order',
        'status_update',
        'detail_update'
      )
    ),

  CONSTRAINT fk_notifications_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_notifications_order
    FOREIGN KEY (order_id)
    REFERENCES orders(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_notifications_customer
    FOREIGN KEY (customer_id)
    REFERENCES customers(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  INDEX idx_notifications_created_at (created_at DESC),
  INDEX idx_notifications_read_at (read_at)
) ENGINE=InnoDB;

-- ========================================================
-- 7. ORDER EVENTS (Audit history for field-level diffs)
-- ========================================================
CREATE TABLE IF NOT EXISTS order_events (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),

  order_id CHAR(36) NOT NULL,
  event_type VARCHAR(50) NOT NULL,

  old_value TEXT,
  new_value TEXT,
  note TEXT,

  created_by CHAR(36),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_order_events_order
    FOREIGN KEY (order_id)
    REFERENCES orders(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_order_events_created_by
    FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  INDEX idx_order_events_order_id (order_id)
) ENGINE=InnoDB;

-- ========================================================
-- 8. PAYMENTS (Receipts & installment logs)
-- ========================================================
CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),

  order_id CHAR(36) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  payment_method VARCHAR(50),

  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note TEXT,
  created_by CHAR(36),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_payments_order
    FOREIGN KEY (order_id)
    REFERENCES orders(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_payments_created_by
    FOREIGN KEY (created_by)
    REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  INDEX idx_payments_order_id (order_id)
) ENGINE=InnoDB;
