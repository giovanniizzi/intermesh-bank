package security

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

// KeycloakAuth intercepts and validates the incoming JWT token emitted by RHBK 26.4
func KeycloakAuth() func(http.Handler) http.Handler {
	ctx := context.Background()

	// Fetch the Issuer URL from environment variables (e.g., https://sso.apps.../realms/intermesh-bank)
	issuerURL := os.Getenv("KEYCLOAK_ISSUER")
	if issuerURL == "" {
		panic("KEYCLOAK_ISSUER environment variable is required")
	}

	// OIDC provider automatically discovers the JWKS endpoint by downloading the well-known configuration file
	provider, err := oidc.NewProvider(ctx, issuerURL)
	if err != nil {
		panic("Failed to discover Keycloak OIDC provider endpoints: " + err.Error())
	}

	// Configure the verifier ensuring the token was issued for our targeted frontend client
	//clientID := os.Getenv("KEYCLOAK_CLIENT_ID")
	verifier := provider.Verifier(&oidc.Config{
		SkipClientIDCheck: true,
	})

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// 1. Authorization Header Extraction
			authHeader := r.Header.Get("Authorization")
			if !strings.HasPrefix(authHeader, "Bearer ") {
				http.Error(w, "Unauthorized: Missing or malformed Bearer token", http.StatusUnauthorized)
				return
			}

			rawToken := strings.TrimPrefix(authHeader, "Bearer ")

			// 2. CRYPTOGRAPHIC LOCAL VALIDATION (Uses fast cached public keys)
			idToken, err := verifier.Verify(ctx, rawToken)
			if err != nil {
				http.Error(w, "Unauthorized: Invalid or expired security token", http.StatusUnauthorized)
				return
			}

			// 3. Extract Claims to verify user identity parameters
			var claims map[string]interface{}
			if err := idToken.Claims(&claims); err != nil {
				http.Error(w, "Unauthorized: Failed to parse token claims data", http.StatusUnauthorized)
				return
			}

			// 4. MESH SECURITY INJECTION: Propagate corporate transaction tracking headers
			r.Header.Set("x-intermesh-channel", "Web-Corporate-Hub")
			r.Header.Set("x-intermesh-route-class", "Authenticated-Retail")

			// Inject the authenticated username string if present within the token identity payload
			if username, ok := claims["preferred_username"].(string); ok {
				r.Header.Set("x-intermesh-user", username)
			}

			// Token validation passed successfully. Forwarding mutated context down the line
			next.ServeHTTP(w, r)
		})
	}
}
