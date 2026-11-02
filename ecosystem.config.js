module.exports = {
  apps: [
    {
      name: "api-server",
      script: "server.js",
      instances: "max",
      exec_mode: "cluster",
      max_memory_restart: "256M",
      wait_ready: true,
      listen_timeout: 10000,
      kill_timeout: 5000,
      autorestart: true,
      env: {
        NODE_ENV: "production",
        REDIS_PASSWORD: "",
        BING_APP_ID: "",
        MSN_API_KEY: "",
        AMAP_API_KEY: "",
      },
    },
  ],
};
