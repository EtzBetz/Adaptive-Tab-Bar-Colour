"use strict";

/*
 * Definitions of some concepts
 *
 * System colour scheme:
 * The colour scheme of the operating system, usually light or dark.
 *
 * Browser colour scheme:
 * The "website appearance" settings of Firefox, which can be light, dark, or auto.
 *
 * current.scheme:
 * Derived from System and Browser colour scheme and decides whether the light theme or dark theme is preferred.
 *
 * pref.allowDarkLight:
 * A setting that decides if a light theme is allowed to be used when current.scheme is dark, or vice versa.
 *
 * theme-color / meta theme colour:
 * A colour defined with a meta tag by some websites, usually static.
 * It is often more related to the branding than the appearance of the website.
 *
 * Theme:
 * An object that defines the appearance of the Firefox chrome.
 */

import {
	default_homeBackground_light,
	default_homeBackground_dark,
	default_fallbackColour_light,
	default_fallbackColour_dark,
	default_aboutPageColour,
	default_protectedPageColour,
} from "./default_values.js";
import preference from "./preference.js";
import { rgba, dimColour, contrastRatio, relativeLuminance } from "./colour.js";

/** Preference */
const pref = new preference();

/** Lookup table for codified colours */
const colourCode = {
	HOME: {
		get light() {
			return current.homeBackground_light;
		},
		get dark() {
			return current.homeBackground_dark;
		},
	},
	FALLBACK: {
		get light() {
			return current.fallbackColour_light;
		},
		get dark() {
			return current.fallbackColour_dark;
		},
	},
	PLAINTEXT: { light: rgba([236, 236, 236, 1]), dark: rgba([50, 50, 50, 1]) },
	SYSTEM: { light: rgba([255, 255, 255, 1]), dark: rgba([30, 30, 30, 1]) },
	ADDON: { light: rgba([236, 236, 236, 1]), dark: rgba([50, 50, 50, 1]) },
	PDFVIEWER: { light: rgba([249, 249, 250, 1]), dark: rgba([56, 56, 61, 1]) },
	IMAGEVIEWER: { light: undefined, dark: rgba([33, 33, 33, 1]) },
	DEFAULT: { light: rgba([255, 255, 255, 1]), dark: rgba([28, 27, 34, 1]) },
};

/** Variables */
const current = {
	scheme: "light", // "light" or "dark"
	get reversedScheme() {
		return this.scheme === "light" ? "dark" : "light";
	},
	homeBackground_light: rgba(default_homeBackground_light),
	homeBackground_dark: rgba(default_homeBackground_dark),
	fallbackColour_light: rgba(default_fallbackColour_light),
	fallbackColour_dark: rgba(default_fallbackColour_dark),
	customRule: {},
	async update() {
		if (pref.custom) {
			this.homeBackground_light = rgba(pref.homeBackground_light);
			this.homeBackground_dark = rgba(pref.homeBackground_dark);
			this.fallbackColour_light = rgba(pref.fallbackColour_light);
			this.fallbackColour_dark = rgba(pref.fallbackColour_dark);
			this.customRule = pref.customRule;
		} else {
			this.homeBackground_light = rgba(default_homeBackground_light);
			this.homeBackground_dark = rgba(default_homeBackground_dark);
			this.fallbackColour_light = rgba(default_fallbackColour_light);
			this.fallbackColour_dark = rgba(default_fallbackColour_dark);
			this.customRule = {};
		}
		this.scheme = await getCurrentScheme();
	},
};

const darkModeDetection = window.matchMedia("(prefers-color-scheme: dark)");

async function getCurrentScheme() {
	const webAppearanceSetting = await browser.browserSettings.overrideContentColorScheme.get({});
	const scheme = webAppearanceSetting.value;
	if (scheme === "light" || scheme === "dark") {
		return scheme;
	} else {
		return darkModeDetection?.matches ? "dark" : "light";
	}
}

/**
 * Initialises the pref and current.
 */
async function initialise() {
	await pref.normalise();
	await update();
}

/**
 * Updates pref cache and triggers colour change in all windows.
 */
async function prefUpdate() {
	await pref.load();
	await update();
}

/**
 * Triggers colour change in all windows.
 */
async function update() {
	await current.update();
	if (!pref.valid()) await initialise();
	const activeTabs = await browser.tabs.query({ active: true, status: "complete" });
	for (const tab of activeTabs) {
		updateTab(tab);
	}
}

/**
 * Handles incoming messages based on their `reason` codes.
 *
 * @param {object} message The message object containing the `reason` and any additional data.
 * @param {runtime.MessageSender} sender Information about the message sender.
 */
function handleMessage(message, sender) {
	const tab = sender.tab;
	const actions = {
		INIT_REQUEST: initialise,
		UPDATE_REQUEST: prefUpdate,
		SCRIPT_LOADED: async () => setFrameColour(tab.windowId, await getWebPageColour()),
		COLOUR_UPDATE: () => setFrameColour(tab.windowId, message.response.colour),
	};
	if (tab?.active && message?.reason in actions) {
		actions[message.reason]();
	} else {
		update();
	}
}

function getAboutPageColour(pathname) {
	if (default_aboutPageColour[pathname]?.[current.scheme]) {
		return rgba(default_aboutPageColour[pathname][current.scheme]);
	} else if (default_aboutPageColour[pathname]?.[current.reversedScheme] && pref.allowDarkLight) {
		return rgba(default_aboutPageColour[pathname][current.reversedScheme]);
	} else {
		return "DEFAULT";
	}
}

function getProtectedPageColour(hostname) {
	if (default_protectedPageColour[hostname]?.[current.scheme]) {
		return rgba(default_protectedPageColour[hostname][current.scheme]);
	} else if (default_protectedPageColour[hostname]?.[current.reversedScheme] && pref.allowDarkLight) {
		return rgba(default_protectedPageColour[hostname][current.reversedScheme]);
	} else {
		return "FALLBACK";
	}
}

async function getAddonPageColour(url) {
	const uuid = url.split(/\/|\?/)[2];
	const addonList = await browser.management.getAll();
	for (const addon of addonList) {
		if (!(addon.type === "extension" && addon.hostPermissions)) continue;
		for (const host of addon.hostPermissions) {
			if (
				host.startsWith("moz-extension:") &&
				uuid === host.split(/\/|\?/)[2] &&
				`Add-on ID: ${addon.id}` in pref.customRule
			) {
				return pref.customRule[`Add-on ID: ${addon.id}`];
			} else continue;
		}
	}
	return "ADDON";
}

/**
 * Configures the content script and uses the tab's colour to apply theme.
 *
 * @param {tabs.Tab} tab The tab to contact.
 */
async function getWebPageColour(tab) {
	const url = tab.url;
	const customRule = null;
	for (const site in pref.customRule) {
		try {
			if (url === site) {
				customRule = pref.customRule[site];
				break;
			}
			// To-do: use match pattern
			/* const regex = new RegExp(site);
			if (regex.test(url)) {
				customRule = pref.customRule[site];
			} */
			if (new URL(url).hostname === site) {
				customRule = pref.customRule[site];
				break;
			}
		} catch (e) {
			continue;
		}
	}
	const response = await browser.tabs.sendMessage(tab.id, {
		reason: "COLOUR_REQUEST",
		conf: {
			dynamic: pref.dynamic,
			noThemeColour: pref.noThemeColour,
			customRule: customRule,
		},
	});
	console.log("Response from tab", url, ":", response);
	if (response) {
		// The colour is successfully returned
		return response.colour;
	} else if (url.startsWith("data:image")) {
		// Viewing an image on data:image (content script is blocked on data:pages)
		return "IMAGEVIEWER";
	} else if (url.endsWith(".pdf") || tab.title.endsWith(".pdf")) {
		// When viewing a PDF file, Firefox blocks content script
		return "PDFVIEWER";
	} else if (tab.favIconUrl?.startsWith("chrome:")) {
		// The page probably failed to load (content script is also blocked on website that failed to load)
		return "DEFAULT";
	} else if (url.match(new RegExp(`https?:\/\/${tab.title}$`))) {
		// When viewing plain text online, Firefox blocks content script
		// In this case, the tab title is the same as the URL
		return "PLAINTEXT";
	} else {
		// Uses fallback colour
		return "FALLBACK";
	}
}

/**
 * Updates the colour for an active tab of a window.
 *
 * @param {tabs.Tab} tab The active tab.
 */
async function updateTab(tab) {
	const url = new URL(tab.url);
	const windowId = tab.windowId;
	if (url.protocol === "view-source:") {
		setFrameColour(windowId, "PLAINTEXT");
	} else if (url.protocol === "chrome:" || url.protocol === "resource:" || url.protocol === "jar:file:") {
		if (
			url.href.endsWith(".txt") ||
			url.href.endsWith(".css") ||
			url.href.endsWith(".jsm") ||
			url.href.endsWith(".js")
		) {
			setFrameColour(windowId, "PLAINTEXT");
		} else if (url.href.endsWith(".png") || url.href.endsWith(".jpg")) {
			setFrameColour(windowId, "IMAGEVIEWER");
		} else {
			setFrameColour(windowId, "SYSTEM");
		}
	} else if (url.protocol === "about:") {
		setFrameColour(windowId, getAboutPageColour(url.pathname));
	} else if (url.hostname in default_protectedPageColour) {
		setFrameColour(windowId, getProtectedPageColour(url.hostname));
	} else if (url.protocol === "moz-extension:") {
		setFrameColour(windowId, await getAddonPageColour(url.href));
	} else {
		// To-do: unify custom rules for about / protected pages with those for normal web pages
		setFrameColour(windowId, await getWebPageColour(tab));
	}
}

// To-do: increase the contrast ratio automatically instead of using fallback colour
function contrastCorrection(colour) {
	const contrastRatio_dark = contrastRatio(colour, rgba([255, 255, 255, 1]));
	const contrastRatio_light = contrastRatio(colour, rgba([0, 0, 0, 1]));
	const eligibility_dark = contrastRatio_dark > pref.minContrast_dark;
	const eligibility_light = contrastRatio_light > pref.minContrast_light;
	if (eligibility_light && (current.scheme === "light" || (current.scheme === "dark" && pref.allowDarkLight))) {
		return { colour: colour, scheme: "light" };
	} else if (eligibility_dark && (current.scheme === "dark" || (current.scheme === "light" && pref.allowDarkLight))) {
		return { colour: colour, scheme: "dark" };
	} else if (current.scheme === "light") {
		const dim =
			((pref.minContrast_light / contrastRatio_light - 1) * relativeLuminance(colour)) /
			(255 - relativeLuminance(colour));
		return { colour: rgba(dimColour(colour, dim)), scheme: "light" };
	} else if (current.scheme === "dark") {
		const dim = contrastRatio_dark / pref.minContrast_dark - 1;
		return { colour: rgba(dimColour(colour, dim)), scheme: "dark" };
	}
}

/**
 * Changes tab bar to the appointed colour. If the colour is not eligible, uses fallback colour.
 *
 * @param {number} windowId The ID of the window.
 * @param {object | string} colour The colour to change to (in rgb object) or a colour code. Colour codes are: `HOME`, `FALLBACK`, `IMAGEVIEWER` (dark only), `PLAINTEXT`, `SYSTEM`, `ADDON`, `PDFVIEWER`, and `DEFAULT`.
 */
function setFrameColour(windowId, colour) {
	if (typeof colour === "string") {
		if (colourCode[colour][current.scheme]) {
			applyTheme(windowId, colourCode[colour][current.scheme], current.scheme);
		} else if (colourCode[colour][current.reversedScheme] && pref.allowDarkLight) {
			applyTheme(windowId, colourCode[colour][current.reversedScheme], current.reversedScheme);
		} else {
			applyTheme(windowId, colourCode["FALLBACK"][current.scheme], current.scheme);
		}
	} else {
		const correctionResult = contrastCorrection(colour);
		applyTheme(windowId, correctionResult.colour, correctionResult.scheme);
	}
}

/**
 * Constructs a theme and applies it to a given window.
 *
 * @param {number} windowId The ID of the window.
 * @param {object} colour Colour of the frame, in rgba object.
 * @param {string} colourScheme "light" or "dark".
 */
function applyTheme(windowId, colour, colourScheme) {
	if (colourScheme === "light") {
		const theme = {
			colors: {
				// Tabbar & tab
				frame: dimColour(colour, -pref.tabbar * 1.5),
				frame_inactive: dimColour(colour, -pref.tabbar * 1.5),
				tab_selected: dimColour(colour, -pref.tabSelected * 1.5),
				ntp_background: dimColour(colour, 0),
				// Toolbar
				toolbar: dimColour(colour, -pref.toolbar * 1.5),
				toolbar_top_separator: "rgba(0, 0, 0, 0)",
				toolbar_bottom_separator: dimColour(colour, (-pref.toolbarBorder - pref.toolbar) * 1.5),
				// URL bar
				toolbar_field: dimColour(colour, -pref.toolbarField * 1.5),
				toolbar_field_border: "rgba(0, 0, 0, 0)",
				toolbar_field_focus: dimColour(colour, -pref.toolbarFieldOnFocus * 1.5),
				toolbar_field_border_focus: "rgb(130, 180, 245)",
				// Sidebar & popup
				sidebar: dimColour(colour, -pref.sidebar * 1.5),
				sidebar_border: dimColour(colour, (-pref.sidebar - pref.sidebarBorder) * 1.5),
				popup: dimColour(colour, -pref.popup * 1.5),
				popup_border: dimColour(colour, (-pref.popup - pref.popupBorder) * 1.5),
				// Static
				tab_background_text: "rgb(30, 30, 30)",
				tab_loading: "rgba(0, 0, 0, 0)",
				tab_line: "rgba(0, 0, 0, 0)",
				ntp_text: "rgb(0, 0, 0)",
				toolbar_text: "rgb(0, 0, 0)",
				toolbar_field_text: "rgba(0, 0, 0)",
				popup_text: "rgb(0, 0, 0)",
				sidebar_text: "rgb(0, 0, 0)",
				button_background_hover: "rgba(0, 0, 0, 0.10)",
				button_background_active: "rgba(0, 0, 0, 0.15)",
				icons: "rgb(30, 30, 30)",
			},
			properties: {
				// More on: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/theme#properties
				color_scheme: "system",
				content_color_scheme: "system",
			},
		};
		browser.theme.update(windowId, theme);
	}
	if (colourScheme === "dark") {
		const theme = {
			colors: {
				// Tabbar & tab
				frame: dimColour(colour, pref.tabbar),
				frame_inactive: dimColour(colour, pref.tabbar),
				tab_selected: dimColour(colour, pref.tabSelected),
				ntp_background: dimColour(colour, 0),
				// Toolbar
				toolbar: dimColour(colour, pref.toolbar),
				toolbar_top_separator: "rgba(0, 0, 0, 0)",
				toolbar_bottom_separator: dimColour(colour, pref.toolbarBorder + pref.toolbar),
				// URL bar
				toolbar_field: dimColour(colour, pref.toolbarField),
				toolbar_field_border: dimColour(colour, pref.toolbarFieldBorder),
				toolbar_field_focus: dimColour(colour, pref.toolbarFieldOnFocus),
				toolbar_field_border_focus: "rgb(70, 118, 160)",
				// Sidebar
				sidebar: dimColour(colour, pref.sidebar),
				sidebar_border: dimColour(colour, pref.sidebar + pref.sidebarBorder),
				popup: dimColour(colour, pref.popup),
				popup_border: dimColour(colour, pref.popup + pref.popupBorder),
				// Static
				tab_background_text: "rgb(225, 225, 225)",
				tab_loading: "rgba(0, 0, 0, 0)",
				tab_line: "rgba(0, 0, 0, 0)",
				ntp_text: "rgb(255, 255, 255)",
				toolbar_text: "rgb(255, 255, 255)",
				toolbar_field_text: "rgb(255, 255, 255)",
				popup_text: "rgb(225, 225, 225)",
				sidebar_text: "rgb(225, 225, 225)",
				button_background_active: "rgba(255, 255, 255, 0.15)",
				button_background_hover: "rgba(255, 255, 255, 0.10)",
				icons: "rgb(225, 225, 225)",
			},
			properties: {
				color_scheme: "system",
				content_color_scheme: "system",
			},
		};
		browser.theme.update(windowId, theme);
	}
}

(async () => {
	await initialise();
	browser.tabs.onUpdated.addListener(update);
	browser.tabs.onActivated.addListener(update);
	browser.tabs.onAttached.addListener(update);
	browser.windows.onFocusChanged.addListener(update);
	browser.runtime.onMessage.addListener(handleMessage);
	darkModeDetection?.addEventListener("change", update);
})();
