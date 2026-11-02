package com.gpsverify.lookup

import android.content.Context
import android.os.Handler
import android.os.Looper

/**
 * The offline site database.
 *
 * The complete seed file ships inside the APK (`assets/sites.json`), so a
 * lookup never touches the network. The file is parsed once, lazily, off the
 * main thread; callers use [load] and are handed the ready database.
 */
object SiteRepository {

    /** Tower Co ID -> sites. The seed has unique IDs, but a list keeps this
     *  correct even if a future export contains duplicates. */
    private var byTowercoId: Map<String, List<Site>> = emptyMap()

    /** Every site, ordered by site ID, for the browse list. */
    private var all: List<Site> = emptyList()

    @Volatile
    private var loaded = false

    private val main = Handler(Looper.getMainLooper())

    val isLoaded: Boolean get() = loaded

    /** Total number of sites in the bundled database. */
    val count: Int get() = all.size

    /**
     * Parse the bundled database if it has not been parsed yet, then invoke
     * [onReady] on the main thread. Safe to call repeatedly.
     */
    fun load(context: Context, onReady: () -> Unit) {
        if (loaded) {
            onReady()
            return
        }
        Thread {
            val app = context.applicationContext
            val sites = parse(app)
            synchronized(this) {
                byTowercoId = sites.groupBy { it.towercoId }
                all = sites.sortedBy { it.siteId }
                loaded = true
            }
            main.post(onReady)
        }.apply { name = "site-db-loader" }.start()
    }

    private fun parse(context: Context): List<Site> {
        val out = ArrayList<Site>(3000)
        context.assets.open("sites.tsv").bufferedReader(Charsets.UTF_8).useLines { lines ->
            for (line in lines) {
                if (line.isEmpty()) continue
                // towercoId \t siteId \t siteName
                val first = line.indexOf('\t')
                if (first <= 0) continue
                val second = line.indexOf('\t', first + 1)
                if (second <= first) continue
                val towercoId = line.substring(0, first)
                val siteId = line.substring(first + 1, second)
                val siteName = line.substring(second + 1)
                if (towercoId.isEmpty() || siteId.isEmpty()) continue
                out.add(Site(siteId, siteName, towercoId))
            }
        }
        return out
    }

    /** Exact Tower Co ID match. Returns an empty list when not found. */
    fun lookup(towercoId: String): List<Site> {
        val key = normalise(towercoId)
        if (key.isEmpty()) return emptyList()
        return byTowercoId[key].orEmpty()
    }

    /**
     * Free-text search across the site ID, site name and Tower Co ID.
     * An exact Tower Co ID match is always ranked first.
     */
    fun search(query: String): List<Site> {
        val q = normalise(query)
        if (q.isEmpty()) return all
        val exact = byTowercoId[q].orEmpty()
        val rest = all.filter {
            it.towercoId != q &&
                (it.siteId.contains(q, ignoreCase = true) || it.siteName.contains(q, ignoreCase = true))
        }
        return exact + rest
    }

    /**
     * Clean up what the user typed. The web app strips a trailing ".0" because
     * spreadsheets turn numeric IDs into floats; the field app gets IDs from
     * the same paperwork, so it does the same.
     */
    fun normalise(raw: String): String =
        raw.trim().removeSuffix(".0").trim()
}
