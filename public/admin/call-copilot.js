/* =====================================================================
   Module « Assistant d'appel » réutilisable — MaQuickPage.
   Monte dans un conteneur : sélecteur d'approche + arbre guidé + copilote
   vocal temps réel (Azure Speech auto-hébergé + gpt-5.4-mini).
   Utilisé par : calling.html (cockpit, mode compact) et call-assist.html
   (page plein écran). Dépend de call-tree.js (CALL_TREES, mountGuided)
   et de call-assist.css. Le SDK Speech est chargé en async depuis
   /admin/vendor/speech-sdk.min.js (auto-hébergé — plus de CDN externe).

   mountCallAssistant(el, opts) → contrôleur { setSalon(s), guide, tree(),
   stopListening() }.
   opts : { salon:{nom,ville}, compact:bool, onNode:fn, onApproach:fn }
   ===================================================================== */
(function (global) {
  'use strict';

  function esc(s) { return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // Attend que le SDK (script async) soit dispo — au lieu d'échouer si
  // l'utilisateur clique avant la fin du chargement.
  function waitForSDK(cb, timeoutMs) {
    var t0 = Date.now();
    (function poll() {
      if (global.SpeechSDK) return cb(global.SpeechSDK);
      if (Date.now() - t0 > (timeoutMs || 8000)) return cb(null);
      setTimeout(poll, 150);
    })();
  }

  function mountCallAssistant(el, opts) {
    opts = opts || {};
    var salon = opts.salon || { nom: '', ville: '' };
    var approachKey = (function () {
      try {
        var k = localStorage.getItem('call-approach');
        return (k && global.CALL_TREES.list.some(function (a) { return a.key === k; })) ? k : global.CALL_TREES.defaultKey;
      } catch (e) { return global.CALL_TREES.defaultKey; }
    })();
    var currentTree = global.CALL_TREES.get(approachKey);
    var guide = null;

    // ---- Squelette DOM ----
    el.innerHTML = ''
      + '<div class="ap-bar"><span class="ap-lab">Approche :</span><span data-r="pills"></span></div>'
      + (opts.compact ? '' : '<div class="ap-desc" data-r="desc"></div>')
      + '<div data-r="guided"></div>'
      + '<div style="border-top:1px solid var(--border);margin-top:14px;padding-top:12px">'
      +   '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
      +     '<button class="co-btn start" data-r="toggle">🎙 Copilote : démarrer l\'écoute</button>'
      +     '<span class="co-dot" data-r="dot"></span><span style="font-size:12.5px;color:var(--muted)" data-r="state">à l\'arrêt</span>'
      +   '</div>'
      +   '<div class="co-warn" data-r="warn" style="display:none"></div>'
      +   '<div class="co-sugg" data-r="sugg"><div class="lab">💬 Suggestion du copilote</div><div class="txt" data-r="suggtxt">— Démarre l\'écoute pendant l\'appel : le copilote entend le prospect, avance l\'arbre et te souffle la réplique.</div><div class="intent" data-r="intent"></div></div>'
      +   '<div class="co-trans" data-r="trans"></div>'
      +   '<div class="co-note">Au démarrage : choisis <b>« Écran entier »</b> + coche <b>« Partager aussi l\'audio système »</b> (la voix du prospect via ton routage Bluetooth). Rien n\'est enregistré.</div>'
      + '</div>';

    function R(name) { return el.querySelector('[data-r="' + name + '"]'); }

    // ---- Approches ----
    function renderPills() {
      R('pills').innerHTML = global.CALL_TREES.list.map(function (a) {
        return '<button class="ap-pill' + (a.key === approachKey ? ' on' : '') + '" data-ap="' + esc(a.key) + '" title="' + esc(a.school + ' — ' + a.desc) + '">' + esc(a.name) + '</button>';
      }).join(' ');
      var d = R('desc');
      if (d) d.innerHTML = '<b>' + esc(currentTree.school) + '</b> — ' + esc(currentTree.desc);
      Array.prototype.forEach.call(R('pills').querySelectorAll('[data-ap]'), function (b) {
        b.onclick = function () {
          approachKey = b.getAttribute('data-ap');
          try { localStorage.setItem('call-approach', approachKey); } catch (e) {}
          currentTree = global.CALL_TREES.get(approachKey);
          mountTree();
          renderPills();
          if (opts.onApproach) try { opts.onApproach(currentTree); } catch (e) {}
        };
      });
    }
    function mountTree() {
      guide = global.mountGuided(R('guided'), currentTree, { onNode: function (n) { if (opts.onNode) try { opts.onNode(n); } catch (e) {} } });
      api.guide = guide;
    }

    // ---- Copilote (transcription + suggestions) ----
    var recognizer = null, audioCtx = null, procNode = null, dispStream = null, listening = false;
    var transcriptCtx = [];
    var inflight = null, pendingUtterance = null;

    function setState(txt, live) { R('state').textContent = txt; R('dot').classList.toggle('live', !!live); }
    function warn(msg) { var w = R('warn'); w.style.display = msg ? 'block' : 'none'; w.textContent = msg || ''; }

    function addLine(text, partial) {
      var t = R('trans');
      if (partial) {
        var p = t.querySelector('.co-partial');
        if (!p) { p = document.createElement('div'); p.className = 'co-line co-partial'; t.appendChild(p); }
        p.innerHTML = '<span class="who">Prospect</span>' + esc(text);
      } else {
        var p2 = t.querySelector('.co-partial'); if (p2) p2.remove();
        var d = document.createElement('div'); d.className = 'co-line'; d.innerHTML = '<span class="who">Prospect</span>' + esc(text); t.appendChild(d);
      }
      t.scrollTop = t.scrollHeight;
    }

    // Si une nouvelle phrase arrive pendant qu'une requête est en cours :
    // on annule l'ancienne et on envoie la plus récente — la suggestion
    // correspond toujours au dernier état de la conversation.
    function askCopilot(utterance) {
      transcriptCtx.push(utterance);
      if (transcriptCtx.length > 6) transcriptCtx.shift();
      if (inflight) { pendingUtterance = utterance; try { inflight.abort(); } catch (e) {} return; }
      sendCopilot(utterance);
    }
    function sendCopilot(utterance) {
      inflight = new AbortController();
      R('sugg').classList.add('thinking');
      fetch('/admin/api/calling/copilot', {
        method: 'POST', credentials: 'same-origin', signal: inflight.signal,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          utterance: utterance,
          context: transcriptCtx.slice(0, -1),
          current_node: guide.current().id,
          nodes: currentTree.catalog(),
          salon: salon,
          approach: { name: currentTree.name, style: currentTree.style },
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          R('sugg').classList.remove('thinking');
          if (j.suggestion) R('suggtxt').textContent = j.suggestion;
          if (j.intent) R('intent').textContent = 'Intention détectée : ' + j.intent;
          if (j.node_id && currentTree.nodes[j.node_id]) guide.goTo(j.node_id);
        })
        .catch(function () { R('sugg').classList.remove('thinking'); })
        .then(function () {
          inflight = null;
          if (pendingUtterance) { var u = pendingUtterance; pendingUtterance = null; sendCopilot(u); }
        });
    }

    function startListening() {
      var btn = R('toggle');
      btn.disabled = true; btn.textContent = '⏳ Chargement du module vocal…';
      waitForSDK(function (SDK) {
        btn.disabled = false;
        if (!SDK) { btn.textContent = '🎙 Copilote : démarrer l\'écoute'; warn('Le module vocal n\'a pas pu se charger. Recharge la page (Ctrl+F5) — le mode guidé fonctionne quand même.'); return; }
        warn('');
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(function (stream) {
          var at = stream.getAudioTracks();
          if (!at.length) {
            stream.getTracks().forEach(function (t) { t.stop(); });
            btn.textContent = '🎙 Copilote : démarrer l\'écoute';
            warn('Aucun audio partagé. Relance et coche « Partager aussi l\'audio système ».');
            return;
          }
          dispStream = stream;
          stream.getVideoTracks().forEach(function (t) { t.onended = stopListening; });

          fetch('/admin/api/calling/speech-token', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
            .then(function (r) { return r.json(); })
            .then(function (tok) {
              if (!tok.token) throw new Error(tok.error || 'token');
              var speechCfg = SDK.SpeechConfig.fromAuthorizationToken(tok.token, tok.region);
              speechCfg.speechRecognitionLanguage = 'fr-FR';
              // Segmentation rapide : la phrase finale tombe ~500 ms après le silence.
              try { speechCfg.setProperty(SDK.PropertyId.Speech_SegmentationSilenceTimeoutMs, '500'); } catch (e) {}
              var pushStream = SDK.AudioInputStream.createPushStream(SDK.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));

              audioCtx = new (global.AudioContext || global.webkitAudioContext)({ sampleRate: 16000 });
              var src = audioCtx.createMediaStreamSource(new MediaStream([at[0]]));
              procNode = audioCtx.createScriptProcessor(4096, 1, 1);
              var mute = audioCtx.createGain(); mute.gain.value = 0; // évite le larsen
              src.connect(procNode); procNode.connect(mute); mute.connect(audioCtx.destination);
              procNode.onaudioprocess = function (e) {
                var input = e.inputBuffer.getChannelData(0);
                var pcm = new Int16Array(input.length);
                for (var i = 0; i < input.length; i++) { var s = Math.max(-1, Math.min(1, input[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF; }
                pushStream.write(pcm.buffer);
              };

              var audioCfg = SDK.AudioConfig.fromStreamInput(pushStream);
              recognizer = new SDK.SpeechRecognizer(speechCfg, audioCfg);
              recognizer.recognizing = function (s, ev) { if (ev.result.text) addLine(ev.result.text, true); };
              recognizer.recognized = function (s, ev) {
                var txt = ev.result.text && ev.result.text.trim();
                if (txt) { addLine(txt, false); askCopilot(txt); }
              };
              recognizer.canceled = function (s, ev) { setState('erreur : ' + (ev.errorDetails || ev.reason), false); };
              recognizer.startContinuousRecognitionAsync(function () {
                listening = true; setState('à l\'écoute…', true);
                btn.textContent = '■ Arrêter l\'écoute'; btn.className = 'co-btn stop';
              }, function (err) { setState('impossible de démarrer : ' + err, false); btn.textContent = '🎙 Copilote : démarrer l\'écoute'; });
            })
            .catch(function (e) { setState('erreur token : ' + e.message, false); stopListening(); });
        }).catch(function () {
          btn.textContent = '🎙 Copilote : démarrer l\'écoute';
          setState('partage annulé', false);
        });
      });
    }

    function stopListening() {
      listening = false; setState('à l\'arrêt', false);
      var btn = R('toggle');
      btn.textContent = '🎙 Copilote : démarrer l\'écoute'; btn.className = 'co-btn start'; btn.disabled = false;
      try { if (inflight) { inflight.abort(); inflight = null; } } catch (e) {}
      pendingUtterance = null;
      try { if (recognizer) { recognizer.stopContinuousRecognitionAsync(function () { recognizer.close(); recognizer = null; }); } } catch (e) {}
      try { if (procNode) { procNode.disconnect(); procNode = null; } } catch (e) {}
      try { if (audioCtx) { audioCtx.close(); audioCtx = null; } } catch (e) {}
      try { if (dispStream) { dispStream.getTracks().forEach(function (t) { t.stop(); }); dispStream = null; } } catch (e) {}
    }

    R('toggle').onclick = function () { if (listening) stopListening(); else startListening(); };

    // ---- Init ----
    // api DOIT exister avant mountTree() (qui fait api.guide = guide).
    var api = {
      guide: null,
      tree: function () { return currentTree; },
      // Changement de fiche (cockpit) : nouveau salon = nouvel appel →
      // on remet l'arbre au départ et on vide le contexte du copilote
      // (l'écoute, elle, continue si elle est lancée).
      setSalon: function (s) {
        salon = s || { nom: '', ville: '' };
        transcriptCtx = [];
        R('trans').innerHTML = '';
        R('suggtxt').textContent = '— Nouvel appel : l\'arbre est remis au départ.';
        R('intent').textContent = '';
        guide.reset();
      },
      stopListening: stopListening,
    };
    renderPills();
    mountTree();
    return api;
  }

  global.mountCallAssistant = mountCallAssistant;
})(window);
