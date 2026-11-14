// pm2 process file for the production server: `pm2 start ecosystem.config.cjs`
// Settings come from .env (NODE_ENV=production etc.); this file only says how to run the process.
module.exports = {
  apps: [
    {
      name: "casiguro-api",
      script: "server.js",
      instances: 1, // Socket.IO broadcasts live in this one process; don't use cluster mode
      exec_mode: "fork",
      // Restart if Node itself grows past this (Chrome for PDFs is a separate process and isn't counted)
      max_memory_restart: "400M",
      kill_timeout: 12000, // server.js finishes open requests for up to 10 s on shutdown
      time: true, // timestamps in the log
      env: { NODE_ENV: "production" },
    },
  ],
};
