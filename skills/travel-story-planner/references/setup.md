# 配置预检与搜索 Key

仅在 get_status 已表明缺少目的地所需 Key、搜索返回实际鉴权/配额错误，或用户明确要求配置 Key 时读取本文件。首次使用本身不触发配置调查。只核对配置状态，不回显或索取完整密钥。

## 检查当前配置

1. 读取 `get_status` 返回的 `search.configured` 和 `search.providers.gaode/locationiq`。前者只表示至少一个 Key 非空，不表示所有地区都适用，也不证明 Key 有效或有剩余配额。国内优先高德，国外使用 LocationIQ；只有高德时不能承诺国外可搜索。国内缺高德而已有 LocationIQ 时提示补配国内主力源，可用现有源尝试核验，但不能隐瞒覆盖限制或保证结果。
2. 没有所需可用搜索源时，在搜索/写入前说明缺哪个 Key、用途、申请入口和配置方式。等待用户自行申请；不要反复搜索，也不要把未配置/鉴权失败当成地点不存在。不替用户注册、申请或购买套餐；已配置的 Key 无需重新申请。

## 配置方式（DSH 插件）

旅行面板的底图与地点搜索是不同能力：底图能显示不代表地点搜索已有凭据。搜索服务需用户自己的 Key，可按服务商当前政策申请免费档或免费配额；不承诺永久免费、无限调用或固定额度，限制以账户与官方页面为准。

| 场景 | 配置项 | 官方申请说明 |
| --- | --- | --- |
| 国内地点搜索、逆地理编码及国内步行/骑行路线 | `gaodeKey` | [高德：创建应用和 Key](https://lbs.amap.com/api/webservice/create-project-and-key)。登录开放平台，创建应用并添加 Key，平台选择 **Web 服务**，不是 Web 端 / JS API |
| 国外地点搜索与逆地理编码；也可用于部分国内地点核验 | `locationiqKey` | [LocationIQ：Access Token](https://docs.locationiq.com/docs/locationiq-access-token)。用户注册并验证邮箱，在控制台 API Access Tokens 获取 Token；[当前套餐与免费档](https://locationiq.com/pricing) |

用户拿到 Key 后，两种方式配置（立即生效，无需重启）：

1. **对话里让你代配**：用户把 Key 发在对话中，调用 `travel_configure({gaodeKey:"…"})` 或 `travel_configure({locationiqKey:"…"})` 写入。配置保存在 `$DSH_HOME/travel-agent.config.json`。
2. **用户自己编辑**：直接编辑 `~/.dsh/travel-agent.config.json`：

```json
{ "gaodeKey": "用户自己的高德Web服务Key", "locationiqKey": "用户自己的LocationIQToken" }
```

按本次目的地配置需要的项；两项互补，不强制无关服务。密钥只保留在本机配置，不放进对话记录以外的任何地方；配置后用 `get_status` 复核 provider 状态，再用本次真实地点搜索核验可用性。

已配置但鉴权、限流或额度不足时说明实际错误，请用户检查服务商控制台，不清空或替换其 Key。Key 尚未补齐时继续可独立完成的需求沟通、天气和攻略研究；暂停依赖缺失源的地点匹配和录入，恢复时沿用原计划与已保存行程。
