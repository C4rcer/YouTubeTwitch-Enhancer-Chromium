/* ==================================================================
 * Chromium (MV3) service-worker entry point. Chrome takes a single
 * background file, so this just pulls in the same scripts the Firefox
 * manifest loads directly. Not referenced by the Firefox manifest.
 * ================================================================== */
importScripts('common.js', 'background.js');
