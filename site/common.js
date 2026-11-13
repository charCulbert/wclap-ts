// The docs layout around the examples: a sidebar, then each example's result beside its code. Nothing here is
// wclap-ts, and no example uses it.

const PAGES = [
    ["index.html", "Getting started"],
    ["01-one-plugin.html", "One plug-in"],
    ["02-chain.html", "A chain"],
    ["03-ab.html", "A/B"],
    ["04-effect-and-automation.html", "Effect and automation"],
    ["05-midi.html", "MIDI"],
    ["06-offline-render.html", "Render to a file"],
    ["07-own-graph.html", "Your own graph"],
    ["08-synth-in-a-window.html", "A synth in a window"],
    ["09-rack.html", "A rack"],
];

// Lays the page out: sidebar; the example's title and lead; its demo (Result) beside its script (Code).
// Light or dark, remembered, as on compost's examples.
const SCHEME = "wclap-ts-color-scheme";
document.documentElement.dataset.colorScheme = localStorage.getItem(SCHEME) === "dark" ? "dark" : "light";
function colorSchemeToggle() {
    const root = document.documentElement;
    const button = document.createElement("button");
    button.className = "color-scheme-toggle";
    const show = () => (button.textContent = root.dataset.colorScheme === "dark" ? "Light mode" : "Dark mode");
    button.onclick = () => {
        root.dataset.colorScheme = root.dataset.colorScheme === "dark" ? "light" : "dark";
        localStorage.setItem(SCHEME, root.dataset.colorScheme);
        show();
    };
    show();
    return button;
}

function layout() {
    const main = document.querySelector("main");
    const here = location.pathname.split("/").pop() || "index.html";
    const nav = document.createElement("nav");
    nav.innerHTML = `<a class="brand" href="index.html">wclap-ts</a>${PAGES.map(
        ([href, name], i) => `<a href="${href}" ${href === here ? 'class="here"' : ""}>${i ? `${i} · ` : ""}${name}</a>`,
    ).join("")}`;
    nav.append(colorSchemeToggle());
    const demo = main.querySelector(".demo");
    const script = document.getElementById("example");
    if (demo && script) {
        const split = document.createElement("div");
        split.className = "split";
        const result = document.createElement("section");
        result.className = "result";
        result.innerHTML = "<h3>Result</h3>";
        result.append(demo);
        const source = document.createElement("section");
        source.className = "source";
        source.innerHTML = '<div class="source-head"><h3>index.html</h3><button class="copy">Copy</button></div>';
        const pre = document.createElement("pre");
        source.append(pre);
        // The whole page as you'd save it: this example without the docs around it.
        void fetch(location.href)
            .then((r) => r.text())
            .then((text) => {
                const html = standalone(new DOMParser().parseFromString(text, "text/html"));
                pre.innerHTML = highlightPage(html);
                source.querySelector(".copy").onclick = async (e) => {
                    await navigator.clipboard.writeText(html);
                    e.target.textContent = "Copied";
                    setTimeout(() => (e.target.textContent = "Copy"), 1500);
                };
            });
        // Other files the example uses, shown under its script.
        for (const extra of main.querySelectorAll("[data-file]")) {
            const file = extra.getAttribute("data-file");
            const heading = document.createElement("h3");
            heading.textContent = file;
            heading.style.marginTop = "18px";
            const filePre = document.createElement("pre");
            source.append(heading, filePre);
            void fetch(file)
                .then((r) => r.text())
                .then((text) => (filePre.innerHTML = highlight(text.trim())));
            extra.remove();
        }
        split.append(result, source);
        main.append(split);
    }
    const page = document.createElement("div");
    page.className = "page";
    main.replaceWith(page);
    page.append(nav, main);
}

// The example as a page of its own: its import map, any styles of its own, its markup and its script.
function standalone(doc) {
    const outdent = (text) => {
        const lines = text.replace(/^\n+|\s+$/g, "").split("\n");
        const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
        return lines.map((l) => l.slice(indent)).join("\n");
    };
    const title = doc.title.replace(/ · wclap-ts$/, "");
    const head = [...doc.head.querySelectorAll('script[type="importmap"], style')].map((e) => outdent(e.outerHTML));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
${head.join("\n")}
</head>
<body>
${outdent(doc.querySelector(".demo").innerHTML).replace(/=""/g, "")}
<script type="module">
${doc.getElementById("example").textContent.trim()}
</script>
</body>
</html>`;
}

// The page's script highlighted as JavaScript; its tags dimmed.
function highlightPage(html) {
    const open = '<script type="module">\n';
    const at = html.indexOf(open);
    const end = html.lastIndexOf("</script>");
    const tags = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/(&lt;\/?[\w!-]+)([^>]*>)/g, '<span class="t">$1$2</span>');
    return tags(html.slice(0, at + open.length)) + highlight(html.slice(at + open.length, end)) + tags(html.slice(end));
}

// Just enough JavaScript highlighting to read by: comments, strings, keywords, numbers.
function highlight(code) {
    const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const rule = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|const|let|await|async|for|of|if|else|return|new|function|export|while|true|false|void)\b|\b(\d+(?:\.\d+)?)\b/g;
    let out = "";
    let last = 0;
    for (const m of code.matchAll(rule)) {
        out += escape(code.slice(last, m.index));
        const kind = m[1] ? "c" : m[2] ? "s" : m[3] ? "k" : "n";
        out += `<span class="${kind}">${escape(m[0])}</span>`;
        last = m.index + m[0].length;
    }
    return out + escape(code.slice(last));
}

layout();
