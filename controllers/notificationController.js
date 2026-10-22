// backend/controllers/notificationController.js
import pool from "../database/db.js";

// Read state is per user (notification_reads), so one account marking a notification
// as read does not mark it read for everyone else.

// GET /api/notifications
export async function getNotifications(req, res) {
  try {
    const [rows] = await pool.query(
      `
      SELECT
        n.id,
        n.notification_type AS type,
        COALESCE(n.user_name, 'Staff') AS user,
        COALESCE(n.order_ref, '') AS orderRef,
        COALESCE(n.customer_name, '') AS customerName,
        n.message AS detail,
        n.created_at AS timestamp,
        r.read_at AS readAt
      FROM notifications n
      LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
      ORDER BY n.created_at DESC
      LIMIT 100
    `,
      [req.user.id]
    );

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
    const [result] = await pool.query(
      `INSERT INTO notification_reads (notification_id, user_id)
      SELECT id, ? FROM notifications WHERE id = ?
      ON DUPLICATE KEY UPDATE read_at = read_at`,
      [req.user.id, id]
    );
    if (result.affectedRows === 0) {
      const [exists] = await pool.query("SELECT id FROM notifications WHERE id = ?", [id]);
      if (exists.length === 0) {
        return res.status(404).json({ message: "Notification not found" });
      }
    }
    res.json({ message: "Notification marked as read", id });
  } catch (err) {
    console.error("markAsRead error:", err);
    res.status(500).json({ message: "Failed to update notification" });
  }
}

// PATCH /api/notifications/read-all
export async function markAllAsRead(req, res) {
  try {
    await pool.query(
      `INSERT INTO notification_reads (notification_id, user_id)
      SELECT n.id, ? FROM notifications n
      LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
      WHERE r.notification_id IS NULL`,
      [req.user.id, req.user.id]
    );
    res.json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("markAllAsRead error:", err);
    res.status(500).json({ message: "Failed to mark all as read" });
  }
}

// GET /api/notifications/unread-count
export async function getUnreadCount(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS unreadCount
      FROM notifications n
      LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
      WHERE r.notification_id IS NULL`,
      [req.user.id]
    );
    res.json({ unreadCount: rows[0]?.unreadCount || 0 });
  } catch (err) {
    console.error("getUnreadCount error:", err);
    res.status(500).json({ message: "Failed to fetch unread count" });
  }
}
