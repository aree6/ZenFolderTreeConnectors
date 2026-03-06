// ==UserScript==
// @name         Zen Folder Tree Connectors
// @description  Draws tree connectors for Zen Browser folders
// @version      1.1
// @author       JustAdumbPrsn
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  /**
   * nsFolderTreeConnectors
   *
   * Manages the drawing of tree connector lines for Zen Browser folders.
   * Optimized to use native events and minimal DOM thrashing.
   */
  class nsFolderTreeConnectors {
    #CONFIG = {
      lineX: 6,
      strokeWidth: 2,
      branchRadius: 7,
      opacity: 0.25,
      branchOvershoot: 0,
    };

    #INJECTED_STYLES = `
      zen-folder .tab-group-container {
        margin-inline-start: 12px !important;
      }

      :root[zen-sidebar-expanded="true"] zen-folder > .tab-group-container,
      .zen-related-group-container {
        position: relative;
      }

      .tree-connector {
        position: absolute;
        top: 0;
        left: -15px;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 0;
      }

      /* Indicator for a parent tab that has visually nested children */
      tab.zen-is-related-parent {
        /* Ensure the absolute connector extending below it is not clipped */
        overflow: visible !important;
      }
      tab.zen-is-related-parent > .tab-stack {
        /* Make sure the tab-stack itself can be styled without overflowing */
        z-index: 1;
        position: relative;
      }
      tab.zen-is-related-child > .tab-stack {
        margin-inline-start: 20px !important;
        width: calc(100% - 20px) !important;
      }
    `;

    #raf = null;
    #resizeObserver = null;

    /**
     * Initializes the tree connectors.
     */
    init() {
      try {
        this.#injectStyles();
        this.#initEventListeners();
        this.#updateVisualRelationships();
      } catch (e) {
        console.error("ZenFolderTreeConnectors init error:", e);
      }
      this.scheduleUpdate();
    }

    /**
     * Injects necessary CSS into the document.
     */
    #injectStyles() {
      if (document.getElementById("tree-connector-styles")) {
        return;
      }
      const style = document.createElement("style");
      style.id = "tree-connector-styles";
      style.textContent = this.#INJECTED_STYLES;
      document.head.appendChild(style);
    }

    /**
     * Helper to create SVG elements with attributes.
     */
    #createElementNS(tag, attrs) {
      const el = document.createElementNS(SVG_NS, tag);
      if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
          el.setAttribute(k, String(v));
        }
      }
      return el;
    }

    /**
     * Recursively finds all visible children in a container,
     * skipping "ghost" folders that are hidden by Zen.
     */
    #getVisibleTreeChildren(container) {
      let result = [];
      if (!container) return result;
      for (const el of container.children) {
        if (!el || el.nodeType !== 1) continue;
        const tag = el.tagName.toUpperCase();
        if (tag === "TAB") {
          if (
            el.offsetHeight > 0 &&
            !el.classList.contains("zen-tab-group-start") &&
            !el.classList.contains("pinned-tabs-container-separator")
          ) {
            result.push(el);
          }
        } else if (tag === "ZEN-FOLDER") {
          if (el.offsetHeight > 0) {
            const rootMost = el.rootMostCollapsedFolder;
            const isInsideCollapsed = rootMost && rootMost !== el;

            const titleEl = el.querySelector(
              ":scope > .tab-group-label-container",
            );
            const isVisuallyGhost =
              !titleEl ||
              titleEl.offsetHeight === 0 ||
              window.getComputedStyle(titleEl).opacity === "0";

            if (isInsideCollapsed || isVisuallyGhost) {
              const innerContainer = el.querySelector(
                ":scope > .tab-group-container",
              );
              result = result.concat(
                this.#getVisibleTreeChildren(innerContainer),
              );
            } else {
              result.push(el);
            }
          }
        }
      }
      return result;
    }

    /**
     * Identifies tabs that are opened from other tabs and tags them.
     */
    #updateVisualRelationships() {
      if (!window.gBrowser || !window.gBrowser.tabs) return;

      let prefEnabled = false;
      try {
        prefEnabled = window.Services?.prefs?.getBoolPref(
          "zen.folders.owned-tabs-in-folder",
          false,
        );
      } catch (e) {}

      if (prefEnabled) {
        // If folders handle this, we don't need visual nesting
        document
          .querySelectorAll(".zen-is-related-child, .zen-is-related-parent")
          .forEach((el) => {
            el.classList.remove(
              "zen-is-related-child",
              "zen-is-related-parent",
            );
            const conn = el.querySelector(":scope > .tree-connector");
            if (conn && conn._isVisualConnector) conn.hidden = true;
          });
        return;
      }

      const tabs = Array.from(window.gBrowser.tabs);

      let currentParent = null;
      let validDescendants = new Set();

      tabs.forEach((tab) => {
        tab.classList.remove("zen-is-related-child", "zen-is-related-parent");

        if (
          tab.pinned ||
          tab.group ||
          tab.classList.contains("zen-tab-group-start")
        ) {
          currentParent = null;
          validDescendants.clear();
          return;
        }

        const owner = tab.ownerTab || tab.openerTab;

        if (
          owner &&
          currentParent &&
          (owner === currentParent || validDescendants.has(owner))
        ) {
          // Valid descendant in the current chain
          tab.classList.add("zen-is-related-child");
          validDescendants.add(tab);

          if (!currentParent.classList.contains("zen-is-related-parent")) {
            currentParent.classList.add("zen-is-related-parent");
          }

          this.#observeElement(tab);
          this.#observeElement(currentParent);
        } else {
          // Start new chain
          currentParent = tab;
          validDescendants.clear();
        }
      });

      // Hide connectors for tabs that are no longer parents
      document.querySelectorAll("tab > .tree-connector").forEach((conn) => {
        if (conn._isVisualConnector) {
          const parentTab = conn.closest("tab");
          if (
            !parentTab ||
            !parentTab.classList.contains("zen-is-related-parent")
          ) {
            conn.hidden = true;
          }
        }
      });
    }

    #observeElement(el) {
      if (!this.#resizeObserver) {
        this.#resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
      }
      if (!el._tcObserved) {
        el._tcObserved = true;
        this.#resizeObserver.observe(el);
      }
    }

    /**
     * Draws connectors for visually nested tabs (parent -> related children).
     */
    #drawVisualConnector(parentTab) {
      const children = [];
      let next = parentTab.nextElementSibling;
      while (next && next.classList.contains("zen-is-related-child")) {
        children.push(next);
        next = next.nextElementSibling;
      }

      let conn = parentTab.querySelector(":scope > .tree-connector");
      if (!children.length) {
        if (conn && conn._isVisualConnector) conn.hidden = true;
        return;
      }

      if (!conn) {
        conn = document.createElement("div");
        conn.className = "tree-connector";
        conn._isVisualConnector = true;
        parentTab.appendChild(conn);
      }
      conn.hidden = false;

      const connectorRect = conn.getBoundingClientRect();
      const { lineX, strokeWidth, branchRadius, opacity, branchOvershoot } =
        this.#CONFIG;

      const pts = children
        .map((child) => {
          const visualChild = child.querySelector(".tab-stack") || child;
          const childRect = visualChild.getBoundingClientRect();
          const style = window.getComputedStyle(visualChild);
          let xOffset = 0;
          let yOffset = 0;

          if (style.transform && style.transform !== "none") {
            try {
              const matrix = new window.DOMMatrix(style.transform);
              xOffset = matrix.m41;
              yOffset = matrix.m42;
            } catch (e) {}
          }

          let endX =
            childRect.left - xOffset - connectorRect.left + branchOvershoot;
          let y = childRect.top - yOffset - connectorRect.top;
          y += visualChild.offsetHeight / 2;

          return {
            y,
            endX,
            r: Math.min(branchRadius, Math.max(0, endX - lineX)),
          };
        })
        .filter((p) => p.y > 1);

      if (!pts.length) {
        conn.hidden = true;
        return;
      }

      const lastPoint = pts[pts.length - 1];
      const trunkEndPointY = lastPoint.y - lastPoint.r;
      if (trunkEndPointY < 0) return;

      const svg = this.#createElementNS("svg", {
        width: "100%",
        height: "100%",
        style:
          "position:absolute;top:0;left:0;overflow:visible;pointer-events:none;",
      });

      const g = this.#createElementNS("g", {
        opacity,
        stroke: "currentColor",
        "stroke-width": strokeWidth,
        fill: "none",
        "stroke-linecap": "round",
      });

      // Adjust starting point to be below the parent tab's main content
      const startY = parentTab.offsetHeight / 2;

      let pathData = `M ${lineX} ${startY} L ${lineX} ${trunkEndPointY}`;
      for (const { y, endX, r } of pts) {
        pathData += ` M ${lineX} ${y - r} A ${r} ${r} 0 0 0 ${lineX + r} ${y} L ${endX} ${y}`;
      }
      g.appendChild(this.#createElementNS("path", { d: pathData }));

      svg.appendChild(g);
      conn.replaceChildren(svg);
    }

    /**
     * Draws the connector SVG for a single folder.
     */
    #drawConnector(folder) {
      const container = folder.querySelector(":scope > .tab-group-container");
      if (!container) return;

      const rootMost = folder.rootMostCollapsedFolder;
      if (rootMost && rootMost !== folder) {
        const ghostConn = container.querySelector(":scope > .tree-connector");
        if (ghostConn) ghostConn.hidden = true;
        return;
      }

      const workspace = folder.closest("zen-workspace");
      const isPinned = folder.closest(".zen-workspace-pinned-tabs-section");
      const isWorkspacePinnedCollapsed =
        isPinned && workspace?.hasAttribute("collapsedpinnedtabs");

      const isSidebarExpanded =
        document.documentElement.getAttribute("zen-sidebar-expanded") ===
        "true";
      const isFolderOpenOrActive =
        (!folder.hasAttribute("collapsed") ||
          folder.hasAttribute("has-active")) &&
        !isWorkspacePinnedCollapsed;

      const kids =
        isSidebarExpanded && isFolderOpenOrActive
          ? this.#getVisibleTreeChildren(container)
          : [];

      let conn = container.querySelector(":scope > .tree-connector");
      if (!kids.length) {
        if (conn) conn.hidden = true;
        return;
      }

      if (!conn) {
        conn = document.createElement("div");
        conn.className = "tree-connector";
        if (getComputedStyle(container).position === "static") {
          container.style.position = "relative";
        }
        container.prepend(conn);
      }
      conn.hidden = false;

      const connectorRect = conn.getBoundingClientRect();
      const { lineX, strokeWidth, branchRadius, opacity, branchOvershoot } =
        this.#CONFIG;

      const pts = kids
        .map((child) => {
          const childRect = child.getBoundingClientRect();
          const style = window.getComputedStyle(child);
          let xOffset = 0;
          let yOffset = 0;

          if (style.transform && style.transform !== "none") {
            try {
              const matrix = new window.DOMMatrix(style.transform);
              xOffset = matrix.m41;
              yOffset = matrix.m42;
            } catch (e) {}
          }

          let endX =
            childRect.left - xOffset - connectorRect.left + branchOvershoot;
          let y = childRect.top - yOffset - connectorRect.top;

          if (child.tagName.toUpperCase() === "ZEN-FOLDER") {
            const titleEl = child.querySelector(
              ":scope > .tab-group-label-container",
            );
            if (titleEl) y += titleEl.offsetHeight / 2;
          } else {
            y += child.offsetHeight / 2;
          }

          return {
            y,
            endX,
            r: Math.min(branchRadius, Math.max(0, endX - lineX)),
          };
        })
        .filter((p) => p.y > 1);

      if (!pts.length) {
        conn.hidden = true;
        return;
      }

      const lastPoint = pts[pts.length - 1];
      const trunkEndPointY = lastPoint.y - lastPoint.r;
      if (trunkEndPointY < 0) return;

      const svg = this.#createElementNS("svg", {
        width: "100%",
        height: "100%",
        style:
          "position:absolute;top:0;left:0;overflow:visible;pointer-events:none;",
      });

      const g = this.#createElementNS("g", {
        opacity,
        stroke: "currentColor",
        "stroke-width": strokeWidth,
        fill: "none",
        "stroke-linecap": "round",
      });

      let pathData = `M ${lineX} 0 L ${lineX} ${trunkEndPointY}`;
      for (const { y, endX, r } of pts) {
        pathData += ` M ${lineX} ${y - r} A ${r} ${r} 0 0 0 ${lineX + r} ${y} L ${endX} ${y}`;
      }
      g.appendChild(this.#createElementNS("path", { d: pathData }));

      svg.appendChild(g);
      conn.replaceChildren(svg);
    }

    /**
     * Schedules a redraw of all connectors on the next animation frame.
     */
    scheduleUpdate() {
      if (this.#raf) return;
      this.#raf = requestAnimationFrame(() => {
        this.#raf = null;
        try {
          this.#updateVisualRelationships();
          document
            .querySelectorAll("zen-folder")
            .forEach((f) => this.#drawConnector(f));
          document
            .querySelectorAll(".zen-is-related-parent")
            .forEach((p) => this.#drawVisualConnector(p));
        } catch (e) {
          console.error("ZenFolderTreeConnectors error during update:", e);
        }
      });
    }

    /**
     * Sets up ResizeObservers on folder containers to detect layout changes.
     */
    #observeContainers() {
      if (!this.#resizeObserver) {
        this.#resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
      }
      document
        .querySelectorAll("zen-folder > .tab-group-container")
        .forEach((container) => {
          if (!container._tcObserved) {
            container._tcObserved = true;
            this.#resizeObserver.observe(container);
          }
        });
    }

    /**
     * Initializes event listeners for Zen's native events.
     */
    #initEventListeners() {
      const nativeEvents = [
        "TabGroupExpand",
        "TabGroupCollapse",
        "TabGrouped",
        "TabUngrouped",
        "FolderGrouped",
        "FolderUngrouped",
        "TabSelect",
        "TabMove",
        "TabOpen",
        "TabClose",
        "TabAttrModified",
      ];
      nativeEvents.forEach((evt) => window.addEventListener(evt, this));
      window.addEventListener("TabGroupCreate", this);

      new MutationObserver(() => this.scheduleUpdate()).observe(
        document.documentElement,
        { attributes: true, attributeFilter: ["zen-sidebar-expanded"] },
      );

      this.#observeContainers();
    }

    /**
     * Dispatches events to their respective on_ handlers.
     */
    handleEvent(aEvent) {
      const methodName = `on_${aEvent.type}`;
      if (methodName in this) {
        this[methodName](aEvent);
      } else {
        this.scheduleUpdate();
      }
    }

    on_TabGroupCreate(event) {
      this.#observeContainers();
      this.scheduleUpdate();
    }

    on_TabGroupExpand(event) {
      this.scheduleUpdate();
    }
    on_TabGroupCollapse(event) {
      this.scheduleUpdate();
    }
    on_TabGrouped() {
      this.scheduleUpdate();
    }
    on_TabUngrouped() {
      this.scheduleUpdate();
    }
    on_FolderGrouped() {
      this.scheduleUpdate();
    }
    on_FolderUngrouped() {
      this.scheduleUpdate();
    }
    on_TabSelect() {
      this.scheduleUpdate();
    }
    on_TabMove() {
      this.scheduleUpdate();
    }
  }

  function initModule() {
    const treeConnector = new nsFolderTreeConnectors();
    treeConnector.init();
  }

  if (document.readyState === "complete") {
    initModule();
  } else {
    window.addEventListener("load", initModule);
  }
})();
