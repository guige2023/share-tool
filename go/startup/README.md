# ShareTool 开机自启动设置

## macOS (launchd)

1. 编译二进制:
   ```bash
   cd go && go build -o sharetool .
   ```

2. 复制到合适位置:
   ```bash
   cp sharetool ~/sharetool
   mkdir -p ~/ShareTool
   ```

3. 修改 macos_sharetool.plist 中的路径和名称

4. 加载:
   ```bash
   cp macos_sharetool.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/macos_sharetool.plist
   ```

5. 取消加载:
   ```bash
   launchctl unload ~/Library/LaunchAgents/macos_sharetool.plist
   ```

## Windows (任务计划程序)
待补充

## Linux (systemd)
待补充
