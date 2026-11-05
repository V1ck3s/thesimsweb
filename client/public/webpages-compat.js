/*
 * Compatibility layer for the game's web pages (Sims/UserData*\/Web Pages/,
 * written by the game from its "Web Templates", nbhd/exporthtml.ts).
 *
 * The templates date from 2000: their scripts only act under Netscape 4
 * (`document.layers`) or Internet Explorer 4/5 (`document.all`). A current
 * browser has neither (its `document.all` is falsy by specification), so the
 * pages stay blank: the layers are never shown, the neighborhood's address
 * book never writes its family frames. The page files are kept as the game
 * writes them; this script, injected at the top of each page when it is
 * viewed (server/src/routes/webpages.ts, client/src/sw/sw.ts), gives them
 * the Internet Explorer objects they use:
 *  - a truthy `document.all` (the real collection behind it);
 *  - `element.all[name]` (a descendant by id or name);
 *  - `iframe.location = url` (Internet Explorer gave the frame's window for
 *    an iframe's id; here the id names the element).
 */
(function () {
  "use strict";
  var real = document.all;

  function descendant(root, key) {
    var sel = '[id="' + CSS.escape(key) + '"],[name="' + CSS.escape(key) + '"]';
    var list = root.querySelectorAll(sel);
    if (list.length === 1) return list[0];
    if (list.length > 1) return list;
    if (/^\d+$/.test(key)) return root.getElementsByTagName("*")[Number(key)];
    return undefined;
  }

  var documentAll = new Proxy(
    {},
    {
      get: function (_target, key) {
        if (typeof key !== "string") return undefined;
        var value = real[key];
        return typeof value === "function" ? value.bind(real) : value;
      },
    },
  );
  Object.defineProperty(document, "all", {
    configurable: true,
    get: function () {
      return documentAll;
    },
  });

  Object.defineProperty(Element.prototype, "all", {
    configurable: true,
    get: function () {
      var el = this;
      return new Proxy(
        {},
        {
          get: function (_target, key) {
            if (key === "length") return el.getElementsByTagName("*").length;
            if (key === "tags") {
              return function (tag) {
                return el.getElementsByTagName(tag);
              };
            }
            return typeof key === "string" ? descendant(el, key) : undefined;
          },
        },
      );
    },
  });

  Object.defineProperty(HTMLIFrameElement.prototype, "location", {
    configurable: true,
    get: function () {
      return this.contentWindow ? this.contentWindow.location : null;
    },
    set: function (url) {
      this.src = url;
    },
  });
})();
