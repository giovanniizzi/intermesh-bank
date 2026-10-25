#!/bin/sh

echo "InterMesh Engine: Substitute KEYCLOAK_URL in app.js..."

sed -i "s|PLACEHOLDER_KEYCLOAK_URL|${KEYCLOAK_URL}|g" /usr/share/nginx/html/js/*.js /usr/share/nginx/html/*.html 2>/dev/null

echo "InterMesh Engine: Sostituzione completata con successo."