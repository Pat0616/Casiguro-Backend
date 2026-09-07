CREATE DATABASE IF NOT EXISTS your_database;
USE your_database;

-- =========================================
-- USERS
-- =========================================

CREATE TABLE users (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;


-- =========================================
-- CUSTOMERS
-- =========================================

CREATE TABLE customers (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  full_name VARCHAR(150) NOT NULL,
  contact_number VARCHAR(50),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;


-- =========================================
-- CATEGORIES
-- =========================================

CREATE TABLE categories (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;


-- =========================================
-- PRODUCTS
-- =========================================

CREATE TABLE products (
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
    ON UPDATE CASCADE
) ENGINE=InnoDB;


-- =========================================
-- ORDERS
-- =========================================

CREATE TABLE orders (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  ref_no VARCHAR(50) UNIQUE NOT NULL,

  customer_id CHAR(36),
  product_id CHAR(36),

  product_name_snapshot VARCHAR(150) NOT NULL,
  category_id CHAR(36),

  order_type VARCHAR(20) NOT NULL,
  quantity INT NOT NULL,
  quantity_completed INT NOT NULL DEFAULT 0,

  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  total_price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,

  payment_status VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL,

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
    ON UPDATE CASCADE
) ENGINE=InnoDB;


-- =========================================
-- ORDER EVENTS
-- =========================================

CREATE TABLE order_events (
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
    ON UPDATE CASCADE
) ENGINE=InnoDB;


-- =========================================
-- PAYMENTS
-- =========================================

CREATE TABLE payments (
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
    ON UPDATE CASCADE
) ENGINE=InnoDB;


-- =========================================
-- NOTIFICATIONS
-- =========================================

CREATE TABLE notifications (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),

  user_id CHAR(36),
  order_id CHAR(36),
  customer_id CHAR(36),

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
    ON DELETE SET NULL
    ON UPDATE CASCADE,

  CONSTRAINT fk_notifications_customer
    FOREIGN KEY (customer_id)
    REFERENCES customers(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE
) ENGINE=InnoDB;
