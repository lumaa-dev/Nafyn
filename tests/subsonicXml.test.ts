import { describe, expect, test } from "bun:test";
import { xmlEscape } from "../server/utils/subsonicResponse";

describe("xmlEscape", () => {
    test("escapes the markup characters", () => {
        expect(xmlEscape(`a & b <c> "d" 'e'`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;");
    });

    test("drops what XML 1.0 forbids, even escaped: control characters and lone surrogates", () => {
        expect(xmlEscape("Intro\u0000\u0008\u001B Outro")).toBe("Intro Outro");
        expect(xmlEscape("bad\uD800surrogate")).toBe("badsurrogate");
        expect(xmlEscape("￾￿ x")).toBe(" x");
    });

    test("keeps text in every script and astral characters", () => {
        expect(xmlEscape("二十歳の恋 🎵 Ünïcode")).toBe("二十歳の恋 🎵 Ünïcode");
    });

    test("tab and newlines survive an attribute as references", () => {
        expect(xmlEscape("a\tb\nc\rd")).toBe("a&#9;b&#10;c&#13;d");
    });
});

import { escapeLike } from "../server/utils/ids";

describe("escapeLike", () => {
    test("wildcards and the escape character itself are escaped with '!'", () => {
        expect(escapeLike("100%_done!")).toBe("100!%!_done!!");
        expect(escapeLike("plain")).toBe("plain");
    });
});
