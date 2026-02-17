const { ModuleFederationPlugin } = require("webpack").container;

module.exports = {
  plugins: [new ModuleFederationPlugin({ name: "app" })],
};
