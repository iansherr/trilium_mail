/*
 * Tests for the message-HTML sanitizer. Message bodies are untrusted input written straight into
 * a note, so these cover two failure directions: markup that must not survive, and legitimate
 * content that must not be lost. The second direction matters as much as the first, because a
 * body silently truncated during import cannot be recovered: the Gmail label has already been
 * advanced to the done state by the time anyone reads the note.
 */
const test = require("node:test");
const assert = require("node:assert");

const { sanitizeHtml, isSafeUrl } = require("../src/gmail-ingest.js");

test("keeps the message body when an attribute value is left unterminated", () => {
    const out = sanitizeHtml('<table><tr><td width="100><p>Invoice total $50</p></td></tr></table><p>Thanks</p>');
    assert.match(out, /Invoice total \$50/);
    assert.match(out, /Thanks/);
});

test("treats an apostrophe in an unquoted value as text, not as a quote", () => {
    const out = sanitizeHtml("<td nowrap width=100 title=Bob's>x</td><p>rest of message</p>");
    assert.match(out, /rest of message/);
    assert.match(out, /width="100"/);
});

test("does not end a tag on a > inside a quoted value", () => {
    const out = sanitizeHtml('<a href="https://e.com/?a=>b" title="x">link</a><p>after</p>');
    assert.match(out, /href="https:\/\/e\.com\/\?a=&gt;b"/);
    assert.match(out, /link/);
    assert.match(out, /after/);
});

test("opens a quoted value across whitespace around the equals sign", () => {
    const out = sanitizeHtml('<a href = "https://e.com/?a=>b">link</a><p>after</p>');
    assert.match(out, /link/);
    assert.match(out, /after/);
});

test("keeps content following an unclosed drop-content element", () => {
    assert.match(sanitizeHtml("<svg><p>after svg no close</p>"), /after svg no close/);
    const style = sanitizeHtml("<style>p{color:red}<p>tail");
    assert.match(style, /tail/);
    assert.doesNotMatch(style, /<style/);
});

test("skips a script body containing < and a quoted >", () => {
    const out = sanitizeHtml('<p>a</p><script>if (a<b && c=">"){}</script><p>keep me</p>');
    assert.match(out, /keep me/);
    assert.doesNotMatch(out, /<script/);
});

test("drops a closed drop-content element together with its content", () => {
    const out = sanitizeHtml("<p>a</p><style>p{color:red}</style><p>b</p>");
    assert.doesNotMatch(out, /color:red/);
    assert.match(out, /<p>b<\/p>/);
});

test("ends the skip at a close tag carrying whitespace or attributes", () => {
    const out = sanitizeHtml("<style type=x>p{}</style ><p>tail</p>");
    assert.match(out, /tail/);
    assert.doesNotMatch(out, /p\{\}/);
});

test("still drops a script nested in an unclosed element", () => {
    const out = sanitizeHtml("<svg><script>alert(1)</script><p>tail");
    assert.doesNotMatch(out, /alert\(1\)/);
    assert.match(out, /tail/);
});

test("rejects relative URLs, which would resolve against Trilium's own origin", () => {
    // An <img> pointing at the Trilium API would make the reader's browser issue that request
    // carrying their session. A message has no base document, so it can mean nothing by one.
    assert.doesNotMatch(sanitizeHtml('<img src="api/notes/root/download">'), /api\/notes/);
    assert.doesNotMatch(sanitizeHtml("<a href=/relative>x</a>"), /href/);
    assert.strictEqual(isSafeUrl(""), false);
    assert.strictEqual(isSafeUrl("///evil.com"), false);
});

test("keeps forms that resolve off-origin or issue no request", () => {
    assert.match(sanitizeHtml("<a href=//cdn.example.com/a.png>x</a>"), /href="\/\/cdn\.example\.com\/a\.png"/);
    assert.strictEqual(isSafeUrl("\\\\cdn.example.com/a.png"), true, "browsers normalise backslashes");
    assert.strictEqual(isSafeUrl("#section"), true);
});

test("keeps cid: for the post-sanitize attachment rewrite", () => {
    // importMessage rewrites cid: references to saved attachments after this sanitizer has run.
    assert.strictEqual(isSafeUrl("cid:abc@example.com"), true);
    assert.match(sanitizeHtml('<img src="cid:logo@example.com">'), /cid:logo@example\.com/);
});

test("does not reduce a hyphenated tag name to its prefix", () => {
    assert.doesNotMatch(sanitizeHtml("<img-fake src=x>"), /<img/);
    assert.match(sanitizeHtml("<style-guide>visible</style-guide>"), /visible/);
});

test("drops markup that could execute", () => {
    const cases = [
        ["event handler", '<img src=x onerror=alert(1)>', /onerror|alert/],
        ["entity-encoded scheme", '<a href="javas&#99;ript:alert(1)">x</a>', /javascript|alert/],
        ["numeric entity scheme", '<a href="&#106;avascript:alert(1)">x</a>', /javascript|alert/],
        ["control char in scheme", '<a href="java\tscript:alert(1)">x</a>', /javascript|alert\(1\)/],
        ["data:text/html", '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>', /data:text\/html/],
        ["data:image/svg+xml", '<img src="data:image/svg+xml;base64,PHN2Zz4=">', /svg\+xml/],
        ["css expression", '<div style="width:expression(alert(1))">x</div>', /expression/],
        ["url(javascript:)", '<div style="background:url(javascript:alert(1))">x</div>', /javascript/],
        ["css import", '<div style="@import url(//evil)">x</div>', /@import/],
        ["vbscript", '<a href="vbscript:msgbox(1)">x</a>', /vbscript/],
        ["quote broken out of an attribute", '<img src="x" onerror="alert(1)><p>y</p>', /onerror|alert/],
        ["entity-escaped attribute break", '<img src="x&quot; onerror=&quot;alert(1)">', /onerror/],
        ["iframe", '<iframe src="https://evil.com"></iframe>', /<iframe/],
        ["svg onload", "<svg onload=alert(1)></svg>", /onload|alert/],
        ["form and input", '<form action="//evil"><input name=p></form>', /<form|<input/],
        ["uppercase script", "<SCRIPT>alert(1)</SCRIPT>", /alert\(1\)/],
        ["meta refresh", '<meta http-equiv=refresh content="0;url=//evil">', /<meta|refresh/],
        ["base href", '<base href="//evil.com/">', /<base/],
        ["srcset", '<img srcset="javascript:alert(1)">', /javascript/]
    ];
    for (const [label, input, forbidden] of cases) {
        assert.doesNotMatch(sanitizeHtml(input), forbidden, label);
    }
});

test("leaves interleaved tag text inert rather than executable", () => {
    // "<scr<script>ipt>" resolves to the text "ipt>alert(1)". The text is harmless; what must
    // never survive is a tag, so this asserts the tag is gone rather than the characters.
    const out = sanitizeHtml("<scr<script>ipt>alert(1)</script>");
    assert.doesNotMatch(out, /<script|<scr>/);
});

test("adds rel=noopener to links it keeps", () => {
    assert.match(sanitizeHtml('<a href="https://example.com">x</a>'), /rel="noopener noreferrer"/);
});

test("terminates on pathological input", () => {
    const input = '<td width="'.repeat(2000) + "x".repeat(50000);
    const started = Date.now();
    sanitizeHtml(input);
    assert.ok(Date.now() - started < 3000, "sanitizer should not degrade to a full-input rescan per tag");
});

test("handles empty, absent, and truncated input", () => {
    assert.strictEqual(sanitizeHtml(""), "");
    assert.strictEqual(sanitizeHtml(null), "");
    assert.strictEqual(sanitizeHtml(undefined), "");
    assert.strictEqual(typeof sanitizeHtml('<p>a</p><div class="x'), "string");
    assert.match(sanitizeHtml("5 < 6 and 7 > 6"), /&lt;/);
});
