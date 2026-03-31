import { describe, expect, it } from "vitest"
import { getClientHtml } from "../src/server.js"

describe("mobile session naming UI", () => {
	it("adds keyboard inset handling for session panel", () => {
		const html = getClientHtml()
		expect(html).toContain("sessionPanel.style.paddingBottom")
		expect(html).toContain("window.innerHeight - vv.height - vv.offsetTop")
	})

	it("scrolls session name input into view when focused", () => {
		const html = getClientHtml()
		expect(html).toContain("newSessionInput.addEventListener('focus'")
		expect(html).toContain("newSessionInput.scrollIntoView")
	})
})
