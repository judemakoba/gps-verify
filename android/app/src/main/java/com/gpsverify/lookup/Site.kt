package com.gpsverify.lookup

/**
 * One tower site.
 *
 * [towercoId] is the 6-digit Tower Co ID the field user types in.
 * [siteId] and [siteName] are what the app displays.
 */
data class Site(
    val siteId: String,
    val siteName: String,
    val towercoId: String,
)
