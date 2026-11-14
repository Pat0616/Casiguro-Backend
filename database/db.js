import mysql from "mysql2/promise";
import { connectionOptions, sessionTimeZone } from "./config.js";

const pool = mysql.createPool({
  ...connectionOptions(),
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,
});

// Runs once per new pooled connection, before it is handed out
pool.on("connection", (connection) => {
  connection.query("SET time_zone = ?", [sessionTimeZone], (error) => {
    if (error) console.error(`Could not set the MySQL session time zone to ${sessionTimeZone}:`, error.message);
  });
});

export default pool;