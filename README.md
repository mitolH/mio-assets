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
演员自主行动（`tests/autonomy.test.mjs`）：地图精灵 ref 上的 `autonomy`（日程 `schedule` + 反应 `reactions`）
必须结构合法；时间槽为 0~47 的整数（一天 48 槽，slot n = n/2 点，`fromSlot > toSlot` 表示跨午夜）；
goto/patrol/wander 的落脚格在图内、非碰撞格、不压剧情地点/传送格，且从演员摆放格可达；会走动的演员摆放格本身必须可走
（不要在其脚下放 collision 方块，运行时它按实时位置占格）；带 `interaction` 的演员运行时不走动，只转向/冒泡。
字段说明见主仓库 `src/shared/types/editor-map.ts` 的 `ActorAutonomy`。

`tests/baseline.json` 记录历史遗留违规，只有**新增**违规才会失败；新素材不要加入基线，应直接修好。
