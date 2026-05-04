    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function() {});

      // Listen for SW sync events
      navigator.serviceWorker.addEventListener('message', function (event) {
        var data = event.data || {};
        if (data.type === 'UPLOAD_SYNC_STARTED') {
          showToast('\u4E0A\u4F20\u961F\u5217\u540C\u6B65\u4E2D\u2026 (' + data.count + ')', 'info', 4000);
        }
        if (data.type === 'UPLOAD_SYNC_COMPLETE') {
          if (data.failed === 0) {
            showToast('\u4E0A\u4F20\u961F\u5217\u5DF2\u5168\u90E8\u5B8C\u6210 (' + data.success + ')', 'success');
          } else {
            showToast('\u4E0A\u4F20\u961F\u5217\u5B8C\u6210 ' + data.success + '\uFF0C\u5931\u8D25 ' + data.failed, 'warn', 6000);
          }
          if (typeof loadFiles === 'function') loadFiles();
          // Remove synced queued items from browser upload queue
          if (data.syncedFilenames && data.syncedFilenames.length) {
            var syncedSet = new Set(data.syncedFilenames);
            var removed = 0;
            for (var i = uploadQueue.length - 1; i >= 0; i--) {
              if (uploadQueue[i].status === 'queued' && syncedSet.has(uploadQueue[i].name)) {
                uploadQueue.splice(i, 1);
                removed++;
              }
            }
            if (removed > 0) renderUploadQueuePanel();
          }
        }
        // Update offline pending count badge when SW reports it
        if (data.type === 'PENDING_COUNT') {
          var badge = document.getElementById('offlinePendingBadge');
          if (badge) {
            if (data.count > 0) {
              badge.textContent = data.count > 99 ? '99+' : data.count;
              badge.style.display = 'inline-block';
            } else {
              badge.style.display = 'none';
            }
          }
        }
      });
    }

    // Queue upload when offline — file: { filename, content, type, token }
    window.queueUpload = function(file) {
      if (!navigator.serviceWorker.controller) return false;
      var mc = new MessageChannel();
      navigator.serviceWorker.controller.postMessage(
        { type: 'QUEUE_UPLOAD', file: file },
        [mc.port2]
      );
      return true;
    };

    // Browser-side online/offline detection
    window.addEventListener('online', function() {
      var banner = document.getElementById('offline-banner');
      if (banner) banner.classList.remove('visible');
      syncUploads();
    });
    window.addEventListener('offline', function() {
      var banner = document.getElementById('offline-banner');
      if (banner) banner.classList.add('visible');
      // Check offline pending count when going offline
      if (window.getOfflinePendingCount) {
        window.getOfflinePendingCount().then(function(count) {
          var badge = document.getElementById('offlinePendingBadge');
          if (badge) {
            if (count > 0) {
              badge.textContent = count > 99 ? '99+' : count;
              badge.style.display = 'inline-block';
            } else {
              badge.style.display = 'none';
            }
          }
        });
      }
    });
    // Show offline banner on initial load if already offline
    if (!navigator.onLine) {
      var banner = document.getElementById('offline-banner');
      if (banner) banner.classList.add('visible');
    }

    // Trigger SW sync
    window.syncUploads = function() {
      if (!navigator.serviceWorker.controller) return;
      navigator.serviceWorker.controller.postMessage({ type: 'SYNC_UPLOADS' });
    };

    // Query IndexedDB pending upload count from SW
    window.getOfflinePendingCount = function() {
      if (!navigator.serviceWorker.controller) return Promise.resolve(0);
      return new Promise(function(resolve) {
        var mc = new MessageChannel();
        mc.port1.onmessage = function(e) {
          mc.port1.close();
          resolve(e.data && e.data.count || 0);
        };
        navigator.serviceWorker.controller.postMessage({ type: 'GET_PENDING_COUNT' }, [mc.port2]);
        // Timeout fallback
        setTimeout(function() {
          try { mc.port1.close(); } catch(e) {}
          resolve(0);
        }, 2000);
      });
    };

    // Advanced search panel toggle
    window.toggleAdvancedSearch = function() {
      var panel = document.getElementById('advancedSearchPanel');
      var btn = document.getElementById('advancedSearchBtn');
      if (!panel) return;
      if (panel.style.display === 'none') {
        panel.style.display = 'block';
        btn.textContent = '高级 ∧';
      } else {
        panel.style.display = 'none';
        btn.textContent = '高级 ⌄';
      }
    };

    // Get current advanced filter values
    function getAdvancedFilters() {
      var sizeMin = document.getElementById('sizeMin') && document.getElementById('sizeMin').value;
      var sizeMax = document.getElementById('sizeMax') && document.getElementById('sizeMax').value;
      var dateFrom = document.getElementById('dateFrom') && document.getElementById('dateFrom').value;
      var dateTo = document.getElementById('dateTo') && document.getElementById('dateTo').value;
      var typeFilter = document.getElementById('typeFilter') && document.getElementById('typeFilter').value;
      var tagMatch = document.getElementById('tagMatchFilter') && document.getElementById('tagMatchFilter').value;
      return { sizeMin, sizeMax, dateFrom, dateTo, typeFilter, tagMatch };
    }

    // Update active filter chips
    function updateActiveFilterChips() {
      var container = document.getElementById('activeFilters');
      if (!container) return;
      var filters = getAdvancedFilters();
      var chips = [];
      if (filters.sizeMin) chips.push('<span class="filter-chip">大小≥' + filters.sizeMin + 'KB</span>');
      if (filters.sizeMax) chips.push('<span class="filter-chip">大小≤' + filters.sizeMax + 'KB</span>');
      if (filters.dateFrom) chips.push('<span class="filter-chip">从' + filters.dateFrom + '</span>');
      if (filters.dateTo) chips.push('<span class="filter-chip">至' + filters.dateTo + '</span>');
      if (filters.typeFilter) chips.push('<span class="filter-chip">类型:' + filters.typeFilter + '</span>');
      if (filters.tagMatch === 'any') chips.push('<span class="filter-chip">标签:任一</span>');
      container.innerHTML = chips.join('');
    }

    // Attach input listeners for filter chips
    ['sizeMin','sizeMax','dateFrom','dateTo','typeFilter','tagMatchFilter'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', updateActiveFilterChips);
    });

    // Apply advanced filters and search
    window.doAdvancedSearch = function() {
      var sizeMin = (document.getElementById('sizeMin') || {}).value || '';
      var sizeMax = (document.getElementById('sizeMax') || {}).value || '';
      var dateFrom = (document.getElementById('dateFrom') || {}).value || '';
      var dateTo = (document.getElementById('dateTo') || {}).value || '';
      var typeFilter = (document.getElementById('typeFilter') || {}).value || '';
      var tagMatchFilter = (document.getElementById('tagMatchFilter') || {}).value || 'all';
      var hasFilters = sizeMin || sizeMax || dateFrom || dateTo || typeFilter;

      // Persist size/date/type filters to localStorage
      localStorage.setItem('adv_size_min', sizeMin);
      localStorage.setItem('adv_size_max', sizeMax);
      localStorage.setItem('adv_date_from', dateFrom);
      localStorage.setItem('adv_date_to', dateTo);
      localStorage.setItem('adv_type', typeFilter);
      localStorage.setItem('adv_tag_match', tagMatchFilter);

      // Update filter chips
      updateActiveFilterChips();

      // If no text query and no advanced filters, just return
      var q = (document.getElementById('searchInput') || {}).value.trim() || '';
      if (!q && !hasFilters) return;

      // Build search URL with all filters
      var params = [];
      if (q) params.push('q=' + encodeURIComponent(q));
      if (sizeMin) params.push('size_min=' + (parseInt(sizeMin) * 1024));
      if (sizeMax) params.push('size_max=' + (parseInt(sizeMax) * 1024));
      if (dateFrom) params.push('date_from=' + Math.floor(new Date(dateFrom).getTime() / 1000));
      if (dateTo) params.push('date_to=' + Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000));
      if (typeFilter) params.push('type=' + typeFilter);
      var tags = (document.getElementById('tagFilterInput') || {}).dataset.selectedTag || '';
      if (tags) params.push('tags=' + encodeURIComponent(tags));
      if (tagMatchFilter === 'any') params.push('tagMatch=any');
      var sort = document.getElementById('sortSelect') && document.getElementById('sortSelect').value;
      var order = document.getElementById('orderSelect') && document.getElementById('orderSelect').value;
      if (sort) params.push('sort=' + sort);
      if (order) params.push('order=' + order);
      // Append search mode (glob/regex bypass FTS5)
      if (_searchMode !== 'normal') params.push('mode=' + _searchMode);

      // Sync typeFilter into main type filter system
      if (typeFilter) {
        currentTypeFilters = [typeFilter];
        localStorage.setItem('typeFilters', typeFilter);
        updateTypeFilterChips();
      }

      var url = '/api/search?' + params.join('&');
      currentSearchQuery = q;
      loadFilesFromUrl(url);
    };

    // Clear advanced filters
    window.clearAdvancedSearch = function() {
      ['sizeMin','sizeMax','dateFrom','dateTo','typeFilter','tagMatchFilter'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      ['adv_size_min','adv_size_max','adv_date_from','adv_date_to','adv_type','adv_tag_match'].forEach(function(k) {
        localStorage.removeItem(k);
      });
      currentTagFilters = [];
      localStorage.setItem('tagFilters', '');
      updateActiveFilterChips();
      renderTagChips();
      document.getElementById('searchResultChip').style.display = 'none';
      loadFiles();
    };

    // Restore advanced filters from localStorage on load
    (function restoreAdvancedFilters() {
      var ids = ['sizeMin','sizeMax','dateFrom','dateTo','typeFilter','tagMatchFilter'];
      var keys = ['adv_size_min','adv_size_max','adv_date_from','adv_date_to','adv_type','adv_tag_match'];
      ids.forEach(function(id, i) {
        var el = document.getElementById(id);
        var stored = localStorage.getItem(keys[i]);
        if (el && stored) el.value = stored;
      });
      // Sync typeFilter from advanced search into currentTypeFilters
      var advType = localStorage.getItem('adv_type');
      if (advType) {
        currentTypeFilters = [advType];
        localStorage.setItem('typeFilters', advType);
        updateTypeFilterChips();
      }
      // Restore tag filters
      var savedTags = localStorage.getItem('tagFilters');
      if (savedTags) {
        currentTagFilters = savedTags.split(',').filter(Boolean);
        renderTagChips();
      }
      // Restore folder tag filter
      var savedFolderTag = localStorage.getItem('folderTagFilter');
      if (savedFolderTag) {
        window._activeFolderTagFilter = savedFolderTag;
        renderFolderTagFilterBar();
      }
      var savedTagMatch = localStorage.getItem('tagMatchMode');
      if (savedTagMatch === 'AND' || savedTagMatch === 'OR') {
        window._tagMatchMode = savedTagMatch;
      }
      updateActiveFilterChips();

      // ── Pull-to-refresh on mobile ─────────────────────────────────────────
      // Works by detecting downward pull gesture on the files panel
      (function initPullToRefresh() {
        var panel = document.getElementById('filesPanel');
        if (!panel) return;
        var touchStartY = 0;
        var pullEl = null;
        var pullIndicator = null;

        function createIndicator() {
          if (pullIndicator) return;
          pullIndicator = document.createElement('div');
          pullIndicator.id = 'pullIndicator';
          pullIndicator.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:6px;font-size:13px;color:var(--muted);padding:10px"><span id="pullSpinner" style="display:none;font-size:16px">↻</span><span id="pullArrow" style="font-size:16px;transition:transform .2s">↓</span> 下拉刷新</div>';
          pullIndicator.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;background:var(--bg-secondary);border-bottom:1px solid var(--line);text-align:center;transform:translateY(-100%);transition:transform .3s;padding-top:max(12px,env(safe-area-inset-top))';
          document.body.appendChild(pullIndicator);
        }

        panel.addEventListener('touchstart', function(e) {
          if (window.scrollY > 10) return; // only when at top
          touchStartY = e.touches[0].clientY;
          createIndicator();
        }, { passive: true });

        panel.addEventListener('touchmove', function(e) {
          if (!pullIndicator) return;
          var delta = e.touches[0].clientY - touchStartY;
          if (delta > 0 && window.scrollY <= 10) {
            e.preventDefault();
            pullIndicator.style.transform = 'translateY(' + Math.min(delta - 60, 0) + 'px)';
            var arrow = document.getElementById('pullArrow');
            if (arrow) arrow.style.transform = 'rotate(' + (Math.min(delta, 60) * 3) + 'deg)';
          }
        }, { passive: false });

        panel.addEventListener('touchend', function() {
          if (!pullIndicator) return;
          var delta = parseInt(pullIndicator.style.transform.replace('translateY(', '').replace('px)', ''), 10);
          if (delta > -30) {
            // Not far enough — snap back
            pullIndicator.style.transform = 'translateY(-100%)';
            setTimeout(function() { if (pullIndicator) { pullIndicator.remove(); pullIndicator = null; } }, 300);
          } else {
            // Trigger refresh
            pullIndicator.style.transform = 'translateY(0)';
            var arrow = document.getElementById('pullArrow');
            var spinner = document.getElementById('pullSpinner');
            if (arrow) arrow.style.display = 'none';
            if (spinner) spinner.style.display = 'inline';
            loadFiles();
            setTimeout(function() {
              pullIndicator.style.transform = 'translateY(-100%)';
              setTimeout(function() { if (pullIndicator) { pullIndicator.remove(); pullIndicator = null; } }, 300);
            }, 800);
          }
        });
      })();
    })();

    // Service Worker registration (PWA offline support)
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(() => {
          // SW registration failure is non-fatal
        });

        // WebSocket status manager with token auth + auto reconnect + real-time UI refresh
        (function wsStatusManager() {
          var chip = document.getElementById('wsStatusChip');
          if (!chip) return;
          var ws = null;
          var reconnectDelay = 2000;
          var maxReconnectDelay = 30000;
          var reconnectTimer = null;
          var lastSyncTs = parseInt(localStorage.getItem('ws_lastSync') || '0', 10);
          var pendingChanges = 0;

          function updateChip(status, color) {
            chip.textContent = status;
            chip.style.color = color || '';
          }

          function connect() {
            // Get a short-lived WebSocket token from the server
            fetch('/api/ws-token', { headers: headers() }).then(function(r) {
              if (!r.ok) throw new Error('Token fetch failed');
              return r.json();
            }).then(function(data) {
              if (!data.token) throw new Error('No token in response');
              var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'wss:';
              var wsUrl = wsProtocol + '//' + location.host + '/ws?token=' + encodeURIComponent(data.token);
              ws = new WebSocket(wsUrl);

              ws.onopen = function() {
                reconnectDelay = 2000;
                updateChip('✅ 已连接', '#10b981');
                // Register this browser as a device
                ws.send(JSON.stringify({
                  type: 'register',
                  payload: {
                    deviceId: 'browser-' + Math.random().toString(36).slice(2, 9),
                    deviceName: navigator.userAgent.slice(0, 50)
                  }
                }));
                // Pull any missed changes since last sync on reconnect
                if (lastSyncTs > 0) {
                  ws.send(JSON.stringify({ type: 'sync_request', payload: { since: Math.floor(lastSyncTs / 1000) } }));
                }
              };

              ws.onmessage = function(ev) {
                try {
                  var msg = JSON.parse(ev.data);
                  if (msg.type === 'file_create' || msg.type === 'file_delete' || msg.type === 'file_update' || msg.type === 'files_changed') {
                    lastSyncTs = Date.now();
                    localStorage.setItem('ws_lastSync', lastSyncTs);
                    pendingChanges++;
                    updateChip('🔄 同步中 (' + pendingChanges + ')', '#f59e0b');

                    // Incremental update: skip server fetch, update currentFiles directly
                    var p = msg.payload || msg;
                    if (!currentSearchQuery && currentVirtualFolderId === null && !isRecentFilesMode) {
                      // Normal browsing mode — incremental update
                      if (msg.type === 'file_create' && p.filename) {
                        // Fetch just the new file metadata (not full list)
                        fetch('/api/file-info/' + encodeURIComponent(p.filename), { headers: headers() })
                          .then(function(r) { return r.json(); })
                          .then(function(data) {
                            if (data.file) {
                              data.file._index = currentFiles.length;
                              _insertFileIncremental(data.file);
                            }
                          }).catch(function() {});
                      } else if (msg.type === 'file_delete' && p.filename) {
                        _removeFileIncremental(p.filename);
                      } else if ((msg.type === 'file_update' || msg.type === 'files_changed') && p.filename) {
                        fetch('/api/file-info/' + encodeURIComponent(p.filename), { headers: headers() })
                          .then(function(r) { return r.json(); })
                          .then(function(data) {
                            if (data.file) {
                              data.file._index = currentFiles.findIndex(function(f) { return f.name === data.file.name; });
                              _updateFileIncremental(data.file);
                            }
                          }).catch(function() {});
                      }
                      pendingChanges = Math.max(0, pendingChanges - 1);
                      if (pendingChanges === 0) updateChip('✅ 已同步', '#10b981');
                    } else {
                      // In search/VF/recent mode — fall back to full reload
                      (async function() {
                        await loadFiles();
                        pendingChanges = Math.max(0, pendingChanges - 1);
                        if (pendingChanges === 0) updateChip('✅ 已同步', '#10b981');
                      })();
                    }
                  } else if (msg.type === 'device_list') {
                    // Devices changed — no UI needed yet
                  } else if (msg.type === 'pong') {
                    // Keepalive response
                  } else if (msg.type === 'sync_response') {
                    // Server pushed changes in response to our sync_request or sync_nudge
                    var syncLogs = (msg.payload && msg.payload.logs) || [];
                    if (syncLogs.length > 0) {
                      // Apply changes locally and mark synced
                      var idsToMark = [];
                      (function processNext(i) {
                        if (i >= syncLogs.length) {
                          // All processed: mark synced and update timestamp
                          if (idsToMark.length > 0) {
                            fetch('/api/sync/mark', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json', ...headers() },
                              body: JSON.stringify({ ids: idsToMark })
                            }).catch(function() {});
                          }
                          lastSyncTs = Date.now();
                          localStorage.setItem('ws_lastSync', lastSyncTs);
                          return;
                        }
                        var log = syncLogs[i];
                        if (log.action === 'create' || log.action === 'update') {
                          if (log.filename && log.content !== undefined) {
                            var formData = new FormData();
                            formData.append('file', new Blob([log.content || ''], { type: 'text/plain' }), log.filename);
                            fetch('/api/upload', { method: 'POST', headers: headers(), body: formData })
                              .then(function(r) { return r.json(); })
                              .then(function(data) {
                                if (data.id) idsToMark.push(log.id);
                                processNext(i + 1);
                              }).catch(function() { processNext(i + 1); });
                          } else {
                            processNext(i + 1);
                          }
                        } else if (log.action === 'delete' && log.filename) {
                          fetch('/api/files/' + encodeURIComponent(log.filename), { method: 'DELETE', headers: headers() })
                            .then(function() { processNext(i + 1); }).catch(function() { processNext(i + 1); });
                        } else if (log.action === 'rename' && log.filename) {
                          processNext(i + 1);
                        } else {
                          idsToMark.push(log.id);
                          processNext(i + 1);
                        }
                      })(0);
                    }
                  }
                } catch(e) {}
              };

              ws.onclose = function() {
                updateChip('⚠️ 离线模式 (重连中…)', '#ef4444');
                scheduleReconnect();
              };

              ws.onerror = function() {
                updateChip('⚠️ 连接失败', '#ef4444');
              };
            }).catch(function(e) {
              updateChip('⚠️ 同步不可用', '#ef4444');
            });
          }

          function scheduleReconnect() {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(function() {
              connect();
              reconnectDelay = Math.min(reconnectDelay * 1.5, maxReconnectDelay);
            }, reconnectDelay);
          }

          connect();

          // Heartbeat: nudge server every 60s to detect stale connections
          setInterval(function() {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'ping' }));
            }
          }, 60000);
        })();
      });
    }
