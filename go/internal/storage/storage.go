package storage

import (
	"os"
	"sort"
)

type FileInfo struct {
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	CreatedAt int64  `json:"createdAt"`
	UpdatedAt int64  `json:"updatedAt"`
}

func ListFiles(dir string) ([]FileInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []FileInfo
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:      e.Name(),
			Size:      fi.Size(),
			CreatedAt: fi.ModTime().UnixMilli(),
			UpdatedAt: fi.ModTime().UnixMilli(),
		})
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].UpdatedAt > files[j].UpdatedAt
	})
	return files, nil
}
