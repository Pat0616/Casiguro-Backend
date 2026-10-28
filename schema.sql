-- ========================================================
-- CASIGURO ENTERPRISES TRANSACTION MANAGEMENT SYSTEM SCHEMA
-- Enterprise Transaction Platform (Catalog -> Quotations -> Orders -> Production)
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
  contact_number VARCHAR(50) NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'employee',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',   -- self-registered accounts wait for admin approval
  approved_by CHAR(36) NULL,
  approved_at TIMESTAMP NULL,
  status_changed_by CHAR(36) NULL,
  status_changed_at TIMESTAMP NULL,
  status_reason TEXT NULL,                          -- rejection / deactivation reason
  last_login_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT chk_users_role CHECK (role IN ('admin', 'employee')),
  CONSTRAINT chk_users_status CHECK (status IN ('pending', 'active', 'rejected', 'deactivated'))
) ENGINE=InnoDB;

-- Self-registration waiting for its emailed code. The user row is created only after the code is entered.
CREATE TABLE IF NOT EXISTS email_verifications (
  email VARCHAR(150) PRIMARY KEY,                   -- lowercased
  code_hash CHAR(64) NOT NULL,                      -- SHA-256 of code + JWT_SECRET; the code itself is never stored
  full_name VARCHAR(150) NOT NULL,
  contact_number VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,              -- bcrypt, same as users.password
  expires_at DATETIME NOT NULL,
  attempts INT NOT NULL DEFAULT 0,                  -- wrong codes entered for the current code
  send_count INT NOT NULL DEFAULT 1,                -- codes sent in the current hour window
  window_started_at DATETIME NOT NULL,
  last_sent_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
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
-- 3. CATEGORIES (Product & Service classifications)
-- ========================================================
CREATE TABLE IF NOT EXISTS categories (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ========================================================
-- 4. PRODUCTS & SERVICES CATALOG (Reference items & base pricing)
-- ========================================================
CREATE TABLE IF NOT EXISTS products (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  category_id CHAR(36),
  type ENUM('product', 'service') NOT NULL DEFAULT 'product',
  name VARCHAR(150) NOT NULL,
  base_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  default_unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  variants JSON NULL,
  description TEXT,
  image_url TEXT,
  is_stock_item BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_products_category
    FOREIGN KEY (category_id)
    REFERENCES categories(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  INDEX idx_products_name (name),
  INDEX idx_products_type (type),
  INDEX idx_products_is_active (is_active)
) ENGINE=InnoDB;

-- ========================================================
-- 5. QUOTATIONS (Pre-order negotiation & pricing agreements)
-- ========================================================
CREATE TABLE IF NOT EXISTS quotations (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  quote_no VARCHAR(50) UNIQUE NOT NULL,
  customer_id CHAR(36),
  customer_name VARCHAR(150) NOT NULL,
  contact_number VARCHAR(50),
  status ENUM('draft', 'sent', 'accepted', 'rejected', 'expired') NOT NULL DEFAULT 'draft',
  valid_until DATE NOT NULL,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  notes TEXT,
  rejection_reason TEXT,
  created_by CHAR(36),
  updated_by CHAR(36),
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

-- ========================================================
-- 6. QUOTATION ITEMS (Line items with price snapshot & reasons)
-- ========================================================
CREATE TABLE IF NOT EXISTS quotation_items (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  quotation_id CHAR(36) NOT NULL,
  product_service_id CHAR(36),
  item_name_snapshot VARCHAR(150) NOT NULL,
  item_description TEXT,
  variant_snapshot VARCHAR(150) NULL,
  category_snapshot VARCHAR(100),
  item_type ENUM('product', 'service') NOT NULL DEFAULT 'product',
  is_custom BOOLEAN NOT NULL DEFAULT FALSE,
  quantity INT NOT NULL DEFAULT 1,
  base_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  final_unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  price_adjustment_reason TEXT,
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

-- ========================================================
-- 6b. SOA COUNTERS (Monthly SOA sequence: period 'YYYY-MM' -> last number issued)
-- ========================================================
CREATE TABLE IF NOT EXISTS soa_counters (
  period CHAR(7) PRIMARY KEY,
  last_seq INT NOT NULL DEFAULT 0
) ENGINE=InnoDB;

-- ========================================================
-- 7. ORDERS (Transactions, production state, and financials)
-- ========================================================
CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  soa_no VARCHAR(20) UNIQUE NOT NULL,       -- Statement of Account No, YYYY-MM-N (system-assigned)
  soa_date DATE NOT NULL,                   -- Date the order was created (system-assigned)
  pr_no VARCHAR(50) NULL,                   -- Customer's Purchase Request No
  po_no VARCHAR(50) NULL,                   -- Customer's Purchase Order No
  jo_no VARCHAR(50) NULL,                   -- Job Order No
  si_or_no VARCHAR(50) NULL,                -- Sales Invoice / Official Receipt No
  si_or_date DATE NULL,
  dr_no VARCHAR(50) NULL,                   -- Delivery Receipt No
  dr_date DATE NULL,
  quotation_id CHAR(36),

  customer_id CHAR(36),
  product_id CHAR(36),
  category_id CHAR(36),

  product_name_snapshot VARCHAR(150) NOT NULL,

  order_type VARCHAR(20) NOT NULL DEFAULT 'custom',
  quantity INT NOT NULL DEFAULT 1,
  quantity_completed INT NOT NULL DEFAULT 0,
  overall_progress INT NOT NULL DEFAULT 0,

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
  cancelled_at TIMESTAMP NULL,              -- set when an admin cancels the order (SOA No stays used)
  cancelled_by CHAR(36) NULL,
  cancel_reason TEXT NULL,

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
    CHECK (status IN ('pending', 'in_production', 'ready', 'completed', 'cancelled')),

  CONSTRAINT fk_orders_customer
    FOREIGN KEY (customer_id)
    REFERENCES customers(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_orders_quotation
    FOREIGN KEY (quotation_id)
    REFERENCES quotations(id)
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

  INDEX idx_orders_soa_date (soa_date),
  INDEX idx_orders_quotation_id (quotation_id),
  INDEX idx_orders_status (status),
  INDEX idx_orders_payment_status (payment_status),
  INDEX idx_orders_due_date (due_date),
  INDEX idx_orders_date_ordered (date_ordered),
  INDEX idx_orders_date_completed (date_completed)
) ENGINE=InnoDB;

-- ========================================================
-- 8. ORDER ITEMS (Multi-item line tracking & itemized production)
-- ========================================================
CREATE TABLE IF NOT EXISTS order_items (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  order_id CHAR(36) NOT NULL,
  product_service_id CHAR(36),
  item_name_snapshot VARCHAR(150) NOT NULL,
  item_description TEXT,
  variant_snapshot VARCHAR(150) NULL,
  category_snapshot VARCHAR(100),
  item_type ENUM('product', 'service') NOT NULL DEFAULT 'product',
  is_custom BOOLEAN NOT NULL DEFAULT FALSE,
  quantity INT NOT NULL DEFAULT 1,
  base_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  final_unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  price_adjustment_reason TEXT,
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

-- ========================================================
-- 9. NOTIFICATIONS (Persistent activity log for offline & online RTC)
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

  CONSTRAINT chk_notifications_type
    CHECK (
      notification_type IN (
        'new_order',
        'status_update',
        'detail_update',
        'quotation_update'
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

  INDEX idx_notifications_created_at (created_at DESC)
) ENGINE=InnoDB;

-- ========================================================
-- 9b. NOTIFICATION READS (Per-user read state: a row means that user has read it)
-- ========================================================
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (notification_id, user_id),

  CONSTRAINT fk_notification_reads_notification
    FOREIGN KEY (notification_id)
    REFERENCES notifications(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  CONSTRAINT fk_notification_reads_user
    FOREIGN KEY (user_id)
    REFERENCES users(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE,

  INDEX idx_notification_reads_user_id (user_id)
) ENGINE=InnoDB;

-- ========================================================
-- 10. ORDER EVENTS (Audit history for field-level diffs)
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
-- 11. PAYMENTS (Down payments, payments & EWT; orders.amount_paid/balance/payment_status are derived from these)
-- Rows are never deleted: a wrong entry is voided (voided_at/by/reason) and stops counting.
-- ========================================================
CREATE TABLE IF NOT EXISTS payments (
  id CHAR(36) PRIMARY KEY,

  order_id CHAR(36) NOT NULL,
  payment_type VARCHAR(20) NOT NULL DEFAULT 'payment',   -- down_payment | payment | ewt (withholding tax, BIR 2307)
  method VARCHAR(20) NULL,                               -- cash | gcash | check | bank_transfer; NULL for EWT and backfilled rows
  amount DECIMAL(12,2) NOT NULL,
  received_on DATE NOT NULL,
  reference_no VARCHAR(100) NULL,                        -- GCash/bank reference, check no., or 2307 certificate no.
  check_bank VARCHAR(100) NULL,
  check_date DATE NULL,
  or_no VARCHAR(50) NULL,                                -- Official Receipt No issued for this payment
  note TEXT NULL,

  voided_at TIMESTAMP NULL,
  voided_by CHAR(36) NULL,
  void_reason TEXT NULL,

  created_by CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_payments_type CHECK (payment_type IN ('down_payment', 'payment', 'ewt')),
  CONSTRAINT chk_payments_method CHECK (method IS NULL OR method IN ('cash', 'gcash', 'check', 'bank_transfer')),
  CONSTRAINT chk_payments_amount CHECK (amount > 0),

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

  CONSTRAINT fk_payments_voided_by
    FOREIGN KEY (voided_by)
    REFERENCES users(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  INDEX idx_payments_order_id (order_id),
  INDEX idx_payments_received_on (received_on)
) ENGINE=InnoDB;

-- ========================================================
-- 12. AUDIT LOGS (Per-account activity trail; append-only)
--     Each entry belongs to the account that performed the action.
-- ========================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id CHAR(36) NULL,               -- NULL only for failed sign-ins with an unknown email
  user_name VARCHAR(150) NULL,         -- name/role as they were at the time of the action
  user_role VARCHAR(20) NULL,
  action VARCHAR(60) NOT NULL,         -- e.g. auth.login, order.update, account.approve
  category VARCHAR(30) NOT NULL,       -- auth | account | order | payment | quotation | catalog
  entity_type VARCHAR(40) NULL,
  entity_id VARCHAR(64) NULL,
  entity_label VARCHAR(150) NULL,      -- e.g. "SOA 2026-10-3", "QTN-2026-0031"
  description TEXT NOT NULL,
  changes JSON NULL,                   -- { field: { from, to } }
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_audit_logs_user_time (user_id, created_at),
  INDEX idx_audit_logs_category (category)
) ENGINE=InnoDB;

CREATE TRIGGER trg_audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
CREATE TRIGGER trg_audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
