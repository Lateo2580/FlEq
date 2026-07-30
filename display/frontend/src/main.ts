import { mount } from "svelte";
import App from "./App.svelte";
import { scheduleQuakeMapAssetPrefetch } from "./lib/quake-map-loader";
import "./lib/theme.css";

scheduleQuakeMapAssetPrefetch();
mount(App, { target: document.getElementById("app")! });
