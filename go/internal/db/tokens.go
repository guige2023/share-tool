package db

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"fmt"
	"time"
)

// Token represents a token record.
type Token struct {
	ID                     int64
	Token                  string
	RefreshToken           string
	RefreshTokenExpiresAt  int64
	DeviceID               string
	ExpiresAt              int64
	CreatedAt              int64
}

// CreateToken creates a new token.
func CreateToken(deviceID string, expiresAt int64) (string, string, error) {
	token := generateToken(32)
	refreshToken := generateToken(64)
	refreshTokenExpiresAt := time.Now().Add(30 * 24 * time.Hour).Unix() // 30 days

	_, err := DB.Exec(`
		INSERT INTO tokens (token, refresh_token, refresh_token_expires_at, device_id, expires_at)
		VALUES (?, ?, ?, ?, ?)`,
		token, refreshToken, refreshTokenExpiresAt, deviceID, expiresAt,
	)
	return token, refreshToken, err
}

// ValidateToken checks if a token is valid.
func ValidateToken(token string) bool {
	var expiresAt int64
	err := DB.QueryRow("SELECT expires_at FROM tokens WHERE token = ?", token).Scan(&expiresAt)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		return false
	}
	// 0 means never expires
	if expiresAt == 0 {
		return true
	}
	return expiresAt > time.Now().Unix()
}

// GetToken returns a token record.
func GetToken(token string) (*Token, error) {
	var t Token
	var refreshToken sql.NullString
	var refreshTokenExpiresAt, deviceID sql.NullInt64
	err := DB.QueryRow(`
		SELECT id, token, refresh_token, refresh_token_expires_at, device_id, expires_at, created_at
		FROM tokens WHERE token = ?`, token,
	).Scan(&t.ID, &t.Token, &refreshToken, &refreshTokenExpiresAt, &deviceID, &t.ExpiresAt, &t.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t.RefreshToken = refreshToken.String
	if refreshTokenExpiresAt.Valid {
		t.RefreshTokenExpiresAt = refreshTokenExpiresAt.Int64
	}
	t.DeviceID = fmt.Sprintf("%d", deviceID.Int64)
	return &t, nil
}

// RefreshToken refreshes a token using the refresh token.
func RefreshToken(refreshToken string) (string, string, error) {
	var id int64
	var expiresAt int64
	err := DB.QueryRow("SELECT id, expires_at FROM tokens WHERE refresh_token = ?", refreshToken).Scan(&id, &expiresAt)
	if err != nil {
		return "", "", err
	}

	// Check if refresh token is expired
	if expiresAt > 0 && expiresAt < time.Now().Unix() {
		return "", "", sql.ErrNoRows
	}

	// Generate new tokens
	newToken := generateToken(32)
	newRefreshToken := generateToken(64)
	newRefreshTokenExpiresAt := time.Now().Add(30 * 24 * time.Hour).Unix()

	_, err = DB.Exec(`
		UPDATE tokens SET token=?, refresh_token=?, refresh_token_expires_at=? WHERE id=?`,
		newToken, newRefreshToken, newRefreshTokenExpiresAt, id,
	)
	return newToken, newRefreshToken, err
}

// DeleteToken removes a token.
func DeleteToken(token string) error {
	_, err := DB.Exec("DELETE FROM tokens WHERE token = ?", token)
	return err
}

// DeleteExpiredTokens removes all expired tokens.
func DeleteExpiredTokens() error {
	_, err := DB.Exec("DELETE FROM tokens WHERE expires_at > 0 AND expires_at < ?", time.Now().Unix())
	return err
}

func generateToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.URLEncoding.EncodeToString(b)[:n]
}
