// Startup file for GoDaddy cPanel "Setup Node.js App" (Phusion Passenger).
// Passenger looks for app.js by default and supplies the port itself.
// Shared hosting defaults: use the host's DNS and run as a single process.
if (process.env.USE_PUBLIC_DNS === undefined) {
  process.env.USE_PUBLIC_DNS = "false";
}
if (process.env.NODE_ENV === undefined) {
  process.env.NODE_ENV = "production";
}

require("./index.js");
