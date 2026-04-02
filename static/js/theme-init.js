(function(){
  var t = localStorage.getItem('rueda-theme') || localStorage.getItem('fpa-theme');
  // If no explicit preference saved, check system dark-mode preference
  if (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    t = 'dark';
  }
  if (t === 'sap')    document.documentElement.classList.add('theme-sap');
  if (t === 'legacy') document.documentElement.classList.add('theme-legacy');
  if (t === 'dark')   document.documentElement.classList.add('theme-dark');
  if (t === 'aero')   document.documentElement.classList.add('theme-aero');
})();
