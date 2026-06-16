import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/snuggle-script-add/",
  plugins: [react()],
});
