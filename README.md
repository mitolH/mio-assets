# mio-assets
MIO Editor Assets

## 素材检查（提交前运行）

```bash
npm test                 # 零依赖，只需 Node ≥ 20
npm run test:baseline    # 重建历史遗留问题基线（仅在确认这些问题暂不处理时使用）
ASSET_REPO_DIR=/path/to/repo npm test   # 检查其它目录（如草稿目录）
./scripts/install-git-hook.sh           # 可选：安装 pre-commit 钩子
```

检查项：组件 schema（尺寸/调色板/索引）、manifest 一一对应、地图引用完整、地面全覆盖无露底、
图层不越界、起点/地点可走且可达、精灵帧引用与尺寸、角色脚底基线/头顶/边缘/绿幕/密度、地面 tile 颜色数。
`tests/baseline.json` 记录历史遗留违规，只有**新增**违规才会失败；新素材不要加入基线，应直接修好。
