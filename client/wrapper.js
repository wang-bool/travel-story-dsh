// 由 build.mjs 追加到打包产物末尾：把打包好的 Travel Story 前端挂到 DSH 客户端。
// 打包产物（IIFE）已设置 window.TravelStoryApp（含 mount(domNode, opts)）。
//
// 形态：整页接管（非弹窗）——
//  • 入口一：DSH 模式选择器里的「旅行模式」（agent preset id=travel，由 Host 端
//    从 standard 复制创建）；选中即接管，切换到其它模式即退出。
//  • 入口二：左下角「🧳 旅行计划」按钮，任意模式下手动开关。
//  • 接管时 DSH 对话框变成右侧浮窗（含模式选择器、思考、正文），思考块
//    背景全透明、字重减轻，尽量不挡地图。
// React 根常驻挂载（AppAgentBridge 一直在线，agent 可通过 navigate 命令自动展开），
// 浮层关闭时仅 display:none，应用内容在展开时才渲染。
window.__ModuleLoader__.load({
  id: "travel-agent",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");

    const TRAVEL_PRESET = "travel";

    let open = false;
    const listeners = new Set();
    function setOpen(v) { open = v; window.__travelPanelOpen = v; listeners.forEach((l) => l()); }
    function useOpen() {
      const [, f] = React.useReducer((x) => x + 1, 0);
      React.useEffect(function () { listeners.add(f); return function () { listeners.delete(f); }; }, []);
      return open;
    }

    // Agent 桥 reveal：runtime 执行 navigate 等命令前调用，自动展开面板
    window.travelStoryHost = { revealWindow: function () { setOpen(true); } };

    // 对话框浮窗 + 思考透明的样式（仅 body.travel-agent-open 时生效）
    const styleTag = document.createElement("style");
    styleTag.dataset.plugin = "travel-agent";
    styleTag.textContent = [
      /* 对话框浮窗：右侧、底部锚定、限高（不挡页面顶部按钮）；半透明 + 毛玻璃。
         z-index 低于 DSH 弹窗层(1000)。slot 容器默认 display:contents（自身无盒，
         多为内联样式），必须 !important 覆盖。 */
      "body.travel-agent-open [data-slot='conversation'].travel-agent-float-chat{position:fixed!important;top:auto!important;bottom:12px!important;right:12px!important;left:auto!important;width:min(460px,44vw)!important;height:min(900px,87vh)!important;z-index:550!important;display:block!important;border-radius:16px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-bg-base,#ffffff) 10%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 12px 48px rgba(0,0,0,0.28);transition:transform .25s ease,opacity .25s ease;}",
      "body[data-ds-dark-theme].travel-agent-open [data-slot='conversation'].travel-agent-float-chat{background:color-mix(in srgb,var(--dsw-alias-bg-base,#17181c) 10%,transparent);}",
      /* 对话视图根容器自带纯白底，透视掉（data-phase 是稳定标识，类名是构建哈希） */
      "body.travel-agent-open .travel-agent-float-chat [data-phase]{background:transparent!important;}",
      /* 输入框卡片保留较高可读性但也半透 */
      "body.travel-agent-open .travel-agent-float-chat [data-composer-card]{background:color-mix(in srgb,var(--dsw-alias-bg-base,#ffffff) 55%,transparent)!important;}",
      "body[data-ds-dark-theme].travel-agent-open .travel-agent-float-chat [data-composer-card]{background:color-mix(in srgb,var(--dsw-alias-bg-base,#17181c) 55%,transparent)!important;}",
      "body.travel-agent-open .travel-agent-float-chat>*{height:100%;}",
      /* hero（新会话页）内容整体落底：标题、模式下拉、输入框都贴在浮窗底部 */
      "body.travel-agent-open .travel-agent-float-chat [data-phase='hero']{display:flex!important;flex-direction:column!important;justify-content:flex-end!important;}",
      /* 收缩：整体滑出右缘，只留工具条上的展开按钮 */
      "body.travel-agent-open.travel-agent-chat-collapsed [data-slot='conversation'].travel-agent-float-chat{transform:translateX(calc(100% + 24px))!important;opacity:0!important;pointer-events:none!important;}",
      /* 思考块：背景全透明、字重减轻，不挡行程计划 */
      "body.travel-agent-open [data-chat-flow-kind='reasoning'],body.travel-agent-open [data-chat-flow-kind='reasoning-delta']{background:transparent!important;font-weight:300!important;opacity:0.72;}",
      "body.travel-agent-open [data-chat-flow-kind='reasoning'] *,body.travel-agent-open [data-chat-flow-kind='reasoning-delta'] *{background:transparent!important;font-weight:inherit!important;}",
    ].join("\n");
    document.head.appendChild(styleTag);

    // 接管时把 DSH 对话框变成浮窗；元素可能被 React 重挂，定时补挂 class
    function useFloatChat(isOpen) {
      React.useEffect(function () {
        document.body.classList.toggle("travel-agent-open", isOpen);
        if (!isOpen) {
          const el = document.querySelector("[data-slot='conversation']");
          if (el) el.classList.remove("travel-agent-float-chat");
          return;
        }
        const applyFloat = function () {
          const el = document.querySelector("[data-slot='conversation']");
          if (el && !el.classList.contains("travel-agent-float-chat")) el.classList.add("travel-agent-float-chat");
        };
        applyFloat();
        const timer = setInterval(applyFloat, 1000);
        return function () { clearInterval(timer); };
      }, [isOpen]);
    }

    function TravelFooterButton(props) {
      const wide = !!(props && props.wide);
      const isOpen = useOpen();
      return React.createElement("button", {
        onClick: function () { setOpen(!open); },
        title: "旅行计划", "aria-label": "旅行计划",
        style: { display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: wide ? "8px 12px" : "8px 0", justifyContent: wide ? "flex-start" : "center", background: "transparent", border: "none", color: isOpen ? "var(--dsw-alias-accent, #3b82f6)" : "var(--dsw-alias-label-secondary, #9ca3af)", cursor: "pointer", borderRadius: "8px", fontSize: "14px" }
      }, React.createElement("span", { style: { fontSize: "16px" } }, "🧳"), wide ? React.createElement("span", null, "旅行计划") : null);
    }

    let apiRef = null; // connection.api（切换 agent preset 用）

    function TravelPage(props) {
      const isOpen = useOpen();
      const ref = React.useRef(null);
      // 当前会话的 agent preset（mode-skin 同款读法）
      const session = props.useSessions ? props.useSessions(function (s) {
        if (s.current === undefined) return undefined;
        const row = s.byId[s.current];
        return row ? { id: s.current, preset: row.agentPreset } : undefined;
      }) : undefined;
      const preset = session && session.preset;
      const wasTravelRef = React.useRef(false);      // 上一次渲染是否在旅行模式
      const lastNonTravelRef = React.useRef(undefined); // 最近的非旅行模式（返回时切回）

      // 模式联动：选中旅行模式 → 接管；切到其它模式 → 退出
      React.useEffect(function () {
        if (preset === TRAVEL_PRESET) setOpen(true);
        else if (wasTravelRef.current) setOpen(false);
        wasTravelRef.current = preset === TRAVEL_PRESET;
        if (preset !== undefined && preset !== TRAVEL_PRESET) lastNonTravelRef.current = preset;
      }, [preset]);

      useFloatChat(isOpen);

      React.useEffect(function () {
        if (!ref.current || !window.TravelStoryApp || typeof window.TravelStoryApp.mount !== "function") return;
        window.TravelStoryApp.mount(ref.current, {
          isOpen: function () { return open; },
          subscribeOpen: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
          onClose: function () { setOpen(false); }
        });
      }, []);

      function backToConversation() {
        if (preset === TRAVEL_PRESET && apiRef && session && session.id) {
          // 旅行模式下「返回对话」= 切回之前的模式（缺省 standard）
          const target = lastNonTravelRef.current || "standard";
          apiRef.agentPresets.select({ sessionId: session.id, agentPreset: target }).catch(function () {});
          setOpen(false);
          return;
        }
        setOpen(false);
      }

      // 对话浮窗的收缩状态（body class 驱动 CSS 滑出右缘）
      const [chatCollapsed, setChatCollapsed] = React.useState(false);
      React.useEffect(function () {
        document.body.classList.toggle("travel-agent-chat-collapsed", chatCollapsed && isOpen);
      }, [chatCollapsed, isOpen]);

      // 播放行程/生成纪录片时浮窗默认收回（离开这些页面自动展开，期间仍可手动展开）
      const [appPath, setAppPath] = React.useState(function () { return (window.TravelStoryApp && window.TravelStoryApp.getPath) ? window.TravelStoryApp.getPath() : "/"; });
      React.useEffect(function () {
        if (!window.TravelStoryApp || typeof window.TravelStoryApp.subscribePath !== "function") return;
        return window.TravelStoryApp.subscribePath(function (p) { setAppPath(p); });
      }, []);
      const prevPathRef = React.useRef(appPath);
      React.useEffect(function () {
        const isPlay = /^\/trip\/[^/]+\/(play|record)$/.test(appPath);
        const wasPlay = /^\/trip\/[^/]+\/(play|record)$/.test(prevPathRef.current || "");
        if (isPlay && !wasPlay) setChatCollapsed(true);
        else if (!isPlay && wasPlay) setChatCollapsed(false);
        prevPathRef.current = appPath;
      }, [appPath]);

      // 浮窗左缘的小工具条：收缩/展开 + 返回对话（浮窗收缩时贴到屏幕右缘）
      const toolBtnStyle = { width: "34px", height: "34px", borderRadius: "50%", border: "1px solid rgba(0,0,0,0.15)", background: "rgba(255,255,255,0.85)", color: "#322d27", cursor: "pointer", fontSize: "14px", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, backdropFilter: "blur(6px)", boxShadow: "0 2px 10px rgba(0,0,0,0.12)" };
      const toolbar = React.createElement("div", {
        style: { position: "absolute", top: "50%", transform: "translateY(-50%)", right: chatCollapsed ? "16px" : "calc(min(460px, 44vw) + 24px)", display: "flex", flexDirection: "column", gap: "8px", zIndex: 20, transition: "right .25s ease" }
      },
        React.createElement("button", {
          onClick: function () { setChatCollapsed(!chatCollapsed); },
          title: chatCollapsed ? "展开对话框" : "收缩对话框到右边", "aria-label": chatCollapsed ? "展开对话框" : "收缩对话框",
          style: toolBtnStyle
        }, chatCollapsed ? "💬" : "»"),
        React.createElement("button", {
          onClick: backToConversation,
          title: "返回 DSH 对话", "aria-label": "返回 DSH 对话",
          style: toolBtnStyle
        }, "✕")
      );

      // 打开时整页接管（盖住 DSH 界面），关闭时还原；React 根常驻，仅切换显示
      // z-index 500：高于 DSH 主内容（≤100），低于 DSH 弹窗层（1000，模型/模式下拉等）
      return React.createElement("div", {
        style: { position: "fixed", inset: 0, zIndex: 500, background: "#F6F1E4", display: isOpen ? "block" : "none" }
      },
        toolbar,
        React.createElement("div", { ref: ref, className: "travel-agent-root", style: { width: "100%", height: "100%", overflow: "auto", position: "relative" } })
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (slots === undefined) return;
      const conn = ctx.get("connection");
      if (conn && conn.api) apiRef = conn.api;
      slots.inject("sidebar.footer.action", function () {
        return slots.register({ name: "sidebar.footer.action", id: "travel-agent", order: 20, label: "旅行计划" }, TravelFooterButton);
      });
      slots.inject("shell.overlay", function () {
        return slots.register({ name: "shell.overlay", id: "travel-agent", order: 100, label: "旅行计划" }, TravelPage);
      });
    }

    exports.apply = apply;
    return module.exports;
  }
});
