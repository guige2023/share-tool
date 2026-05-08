package db

import (
	"database/sql"
	"time"
)

// Device represents a device record.
type Device struct {
	ID          int64
	DeviceID    string
	DeviceName  string
	IP          string
	Port        int
	LastSeen    int64
	IsOnline    bool
	LastSyncAt  int64
	SyncedFiles int
}

// UpsertDevice inserts or updates a device.
func UpsertDevice(deviceID, deviceName, ip string, port int) error {
	_, err := DB.Exec(`
		INSERT INTO devices (device_id, device_name, ip, port, last_seen, is_online)
		VALUES (?, ?, ?, ?, ?, 1)
		ON CONFLICT(device_id) DO UPDATE SET
			device_name=excluded.device_name,
			ip=excluded.ip,
			port=excluded.port,
			last_seen=excluded.last_seen,
			is_online=1`,
		deviceID, deviceName, ip, port,
	)
	return err
}

// GetDevice returns a device by deviceID.
func GetDevice(deviceID string) (*Device, error) {
	var d Device
	var deviceName, ip sql.NullString
	var port, lastSyncAt, syncedFiles sql.NullInt64
	err := DB.QueryRow(`
		SELECT id, device_id, device_name, ip, port, last_seen, is_online, last_sync_at, synced_files
		FROM devices WHERE device_id = ?`, deviceID,
	).Scan(&d.ID, &d.DeviceID, &deviceName, &ip, &port, &d.LastSeen, &d.IsOnline, &lastSyncAt, &syncedFiles)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	d.DeviceName = deviceName.String
	d.IP = ip.String
	if port.Valid {
		d.Port = int(port.Int64)
	}
	if lastSyncAt.Valid {
		d.LastSyncAt = lastSyncAt.Int64
	}
	if syncedFiles.Valid {
		d.SyncedFiles = int(syncedFiles.Int64)
	}
	return &d, nil
}

// ListDevices returns all devices.
func ListDevices() ([]Device, error) {
	rows, err := DB.Query(`
		SELECT id, device_id, device_name, ip, port, last_seen, is_online, last_sync_at, synced_files
		FROM devices ORDER BY last_seen DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var devices []Device
	for rows.Next() {
		var d Device
		var deviceName, ip sql.NullString
		var port, lastSyncAt, syncedFiles sql.NullInt64
		if err := rows.Scan(&d.ID, &d.DeviceID, &deviceName, &ip, &port, &d.LastSeen, &d.IsOnline, &lastSyncAt, &syncedFiles); err != nil {
			return nil, err
		}
		d.DeviceName = deviceName.String
		d.IP = ip.String
		if port.Valid {
			d.Port = int(port.Int64)
		}
		if lastSyncAt.Valid {
			d.LastSyncAt = lastSyncAt.Int64
		}
		if syncedFiles.Valid {
			d.SyncedFiles = int(syncedFiles.Int64)
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

// SetDeviceOffline marks a device as offline.
func SetDeviceOffline(deviceID string) error {
	_, err := DB.Exec("UPDATE devices SET is_online = 0 WHERE device_id = ?", deviceID)
	return err
}

// SetDeviceOnline marks a device as online.
func SetDeviceOnline(deviceID string) error {
	_, err := DB.Exec("UPDATE devices SET is_online = 1, last_seen = ? WHERE device_id = ?", time.Now().Unix(), deviceID)
	return err
}

// UpdateDeviceSync updates the sync status of a device.
func UpdateDeviceSync(deviceID string, syncedFiles int) error {
	_, err := DB.Exec(
		"UPDATE devices SET last_sync_at = ?, synced_files = ? WHERE device_id = ?",
		time.Now().Unix(), syncedFiles, deviceID,
	)
	return err
}

// DeleteDevice removes a device.
func DeleteDevice(deviceID string) error {
	_, err := DB.Exec("DELETE FROM devices WHERE device_id = ?", deviceID)
	return err
}
