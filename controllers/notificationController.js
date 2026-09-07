// backend/controllers/notificationController.js
import pool from "../database/db.js";

// GET /api/notifications
export async function getNotifications(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT
        id,
        notification_type AS type,
        COALESCE(user_name, 'Staff') AS user,
        COALESCE(order_ref, '') AS orderRef,
        COALESCE(customer_name, '') AS customerName,
        message AS detail,
        created_at AS timestamp,
        read_at AS readAt
      FROM notifications
      ORDER BY created_at DESC
      LIMIT 100
    `);

    res.json(rows);
  } catch (err) {
    console.error("getNotifications error:", err);
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
}

// PATCH /api/notifications/:id/read
export async function markAsRead(req, res) {
  try {
    const { id } = req.params;
    await pool.query("UPDATE notifications SET read_at = NOW() WHERE id = ? AND read_at IS NULL", [id]);
    res.json({ message: "Notification marked as read", id });
  } catch (err) {
    console.error("markAsRead error:", err);
    res.status(500).json({ message: "Failed to update notification" });
  }
}

// PATCH /api/notifications/read-all
export async function markAllAsRead(req, res) {
  try {
    await pool.query("UPDATE notifications SET read_at = NOW() WHERE read_at IS NULL");
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("markAllAsRead error:", err);
    res.status(500).json({ message: "Failed to mark all as read" });
  }
}

// GET /api/notifications/unread-count
export async function getUnreadCount(req, res) {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS unreadCount FROM notifications WHERE read_at IS NULL");
    res.json({ unreadCount: rows[0]?.unreadCount || 0 });
  } catch (err) {
    console.error("getUnreadCount error:", err);
    res.status(500).json({ message: "Failed to fetch unread count" });
  }
}

