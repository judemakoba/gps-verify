package com.gpsverify.lookup

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

/**
 * Browse the whole bundled database.
 *
 * Handy when the user does not have a Tower Co ID to hand — they can search
 * by site name or site ID instead. Everything still comes from the APK.
 */
class BrowseActivity : AppCompatActivity() {

    private lateinit var searchBox: androidx.appcompat.widget.AppCompatEditText
    private lateinit var countView: TextView
    private lateinit var adapter: SiteAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_browse)

        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        title = getString(R.string.browse_title)

        searchBox = findViewById(R.id.inputSearch)
        countView = findViewById(R.id.textCount)

        val list = findViewById<RecyclerView>(R.id.listSites)
        list.layoutManager = LinearLayoutManager(this)
        adapter = SiteAdapter { site ->
            // Tapping a row fills the lookup screen with that Tower Co ID.
            startActivity(
                android.content.Intent(this, LookupActivity::class.java)
                    .putExtra(LookupActivity.EXTRA_PREFILL_ID, site.towercoId)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
            )
        }
        list.adapter = adapter

        searchBox.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                applyFilter(s?.toString().orEmpty())
            }
        })

        SiteRepository.load(this) { applyFilter(searchBox.text.toString()) }
    }

    private fun applyFilter(query: String) {
        val results = SiteRepository.search(query)
        adapter.submit(results)
        countView.text = resources.getQuantityString(
            R.plurals.site_count, results.size, results.size
        )
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }
}

/** RecyclerView adapter for the site list. */
class SiteAdapter(
    private val onClick: (Site) -> Unit
) : RecyclerView.Adapter<SiteAdapter.Holder>() {

    private var items: List<Site> = emptyList()

    fun submit(list: List<Site>) {
        items = list
        notifyDataSetChanged()
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val siteId: TextView = view.findViewById(R.id.itemSiteId)
        val siteName: TextView = view.findViewById(R.id.itemSiteName)
        val towerco: TextView = view.findViewById(R.id.itemTowerco)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_site, parent, false)
        return Holder(view)
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val site = items[position]
        holder.siteId.text = site.siteId
        holder.siteName.text = site.siteName
        holder.towerco.text = site.towercoId
        holder.itemView.setOnClickListener { onClick(site) }
    }

    override fun getItemCount(): Int = items.size
}
