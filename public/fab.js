    // FAB + back-to-top auto-show/hide on mobile
    (function() {
      var fab = document.querySelector('.fab');
      var btt = document.getElementById('backToTop');
      if (!fab && !btt) return;
      var lastY = 0;
      var ticking = false;
      window.addEventListener('scroll', function() {
        if (!ticking) {
          requestAnimationFrame(function() {
            var y = document.documentElement.scrollTop || document.body.scrollTop;
            if (y > lastY && y > 100) {
              if (fab) { fab.style.opacity = '0'; fab.style.pointerEvents = 'none'; }
            } else {
              if (fab) { fab.style.opacity = ''; fab.style.pointerEvents = ''; }
            }
            if (btt) {
              if (y > 300) { btt.classList.add('visible'); } else { btt.classList.remove('visible'); }
            }
            lastY = y;
            ticking = false;
          });
          ticking = true;
        }
      }, { passive: true });
    })();
