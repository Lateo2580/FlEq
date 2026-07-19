import { mount } from "svelte";
import PreviewApp from "./PreviewApp.svelte";
import "../lib/theme.css";

mount(PreviewApp, { target: document.getElementById("app")! });
