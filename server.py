#!/usr/bin/env python3
"""Servidor local para probar la app"""
import http.server
import socketserver

PORT = 8000

Handler = http.server.SimpleHTTPRequestHandler

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"🌐 Servidor iniciado en http://localhost:{PORT}")
    print("📱 Abre esta dirección en tu navegador")
    print("⏹  Presiona Ctrl+C para detener")
    httpd.serve_forever()
