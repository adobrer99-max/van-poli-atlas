
(() => {
  const selector = '.nav[role="tablist"] [role="tab"]';
  const disabled = ':disabled,[aria-disabled="true"]';
  const selectTab = (selected) => {
    const panelId = selected.getAttribute("aria-controls");
    for (const tab of selected.closest('[role="tablist"]').querySelectorAll('[role="tab"]')) {
      const active = tab === selected;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
      const id = tab.getAttribute("aria-controls");
      const panel = id && document.getElementById(id);
      if (panel != null) {
        panel.hidden = id !== panelId;
        if (!panel.hidden && selected.id) {
          panel.setAttribute("aria-labelledby", selected.id);
        }
      }
    }
  };
  const interact = (event) => {
    const tab = event.target?.closest?.(selector);
    if (event.defaultPrevented || tab == null || tab.matches(disabled)) {
      return;
    }
    if (event.type === "click") {
      selectTab(tab);
      return;
    }
    const tabs = Array.from(
      tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]'),
    ).filter((candidate) => !candidate.matches(disabled));
    const current = tabs.indexOf(tab);
    let next;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current + tabs.length - 1) % tabs.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabs.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    tabs[next].focus();
    selectTab(tabs[next]);
  };

  for (const list of document.querySelectorAll('.nav[role="tablist"]')) {
    const selected =
      list.querySelector('[role="tab"][aria-selected="true"]') ??
      list.querySelector('[role="tab"].active') ??
      list.querySelector('[role="tab"]');
    if (selected != null) {
      selectTab(selected);
    }
  }
  document.addEventListener("click", interact);
  document.addEventListener("keydown", interact);
  window.addEventListener("pagehide", () => {
    document.removeEventListener("click", interact);
    document.removeEventListener("keydown", interact);
  }, { once: true });
})();
