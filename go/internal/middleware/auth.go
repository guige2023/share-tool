package middleware

import (
	"net/http"
	"strings"
)

// AuthMiddleware validates the share token from request headers or query params.
// If no token is configured, all requests are allowed (open access).
// Tokens are validated against the provided validator function.
func AuthMiddleware(getToken func() string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := getToken()
			if token == "" {
				// No token configured — allow all
				next.ServeHTTP(w, r)
				return
			}

			// Check header: x-auth-token or Authorization: Bearer <token>
			reqToken := r.Header.Get("x-auth-token")
			if reqToken == "" {
				auth := r.Header.Get("Authorization")
				if strings.HasPrefix(auth, "Bearer ") {
					reqToken = strings.TrimPrefix(auth, "Bearer ")
				}
			}

			// Check query param: ?token=...
			if reqToken == "" {
				reqToken = r.URL.Query().Get("token")
			}

			if reqToken != token {
				http.Error(w, `{"error":"Unauthorized"}`, http.StatusUnauthorized)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
