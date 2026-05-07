import { defineConfig } from "vite";

export default defineConfig({
    // Keep this scaffold minimal and stable in this monorepo environment.
    // React plugin is intentionally omitted to avoid dev-time refresh wrapper
    // issues seen here; TSX still compiles via Vite/esbuild.
    base: "/monitoring/",
    plugins: [],
    server: {
        port: 5174,
        proxy: {
            "/api": {
                target: "http://localhost:3001",
                changeOrigin: true,
            },
        },
    },
    preview: {
        port: 5174,
        allowedHosts: ["api.algovity.ai"],
    },
    build: {
        outDir: "dist",
    },
});
