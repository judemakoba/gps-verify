package com.gpsverify.lookup

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.snackbar.Snackbar

/**
 * The lookup screen.
 *
 * The field user types a Tower Co ID and the app answers with a large, bold
 * Site ID and Site Name straight from the database bundled in the APK. There
 * is no login and no network call — the app has no INTERNET permission at all.
 */
class LookupActivity : AppCompatActivity() {

    companion object {
        /** Optional Tower Co ID to pre-fill, used when the user taps a row in
         *  the browse list. */
        const val EXTRA_PREFILL_ID = "prefill_id"
        private const val KEY_LAST_QUERY = "last_query"
    }

    private lateinit var input: androidx.appcompat.widget.AppCompatEditText
    private lateinit var resultCard: View
    private lateinit var siteIdView: TextView
    private lateinit var siteNameView: TextView
    private lateinit var towercoView: TextView
    private lateinit var notFoundView: TextView
    private lateinit var loadingView: View

    private var lastQuery: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_lookup)

        input = findViewById(R.id.inputTowercoId)
        resultCard = findViewById(R.id.resultCard)
        siteIdView = findViewById(R.id.textSiteId)
        siteNameView = findViewById(R.id.textSiteName)
        towercoView = findViewById(R.id.textTowerco)
        notFoundView = findViewById(R.id.textNotFound)
        loadingView = findViewById(R.id.loadingView)

        findViewById<View>(R.id.buttonLookup).setOnClickListener { performLookup() }
        findViewById<View>(R.id.buttonBrowse).setOnClickListener {
            startActivity(Intent(this, BrowseActivity::class.java))
        }
        findViewById<View>(R.id.buttonCopy).setOnClickListener { copyResult() }

        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_DONE) {
                performLookup()
                true
            } else {
                false
            }
        }

        // Clear the previous result as soon as the user edits the ID, so the
        // screen never shows a stale site next to a new ID.
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) {
                if (s.toString() != lastQuery) hideResult()
            }
        })

        savedInstanceState?.getString(KEY_LAST_QUERY)?.let {
            lastQuery = it
            input.setText(it)
        }

        // Coming back from the browse list with a Tower Co ID to look up.
        intent?.getStringExtra(EXTRA_PREFILL_ID)?.let {
            input.setText(it)
            input.setSelection(it.length)
        }

        SiteRepository.load(this) {
            loadingView.visibility = View.GONE
            if (lastQuery.isNotEmpty()) performLookup()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(KEY_LAST_QUERY, lastQuery)
    }

    /** The activity is singleTop, so returning from the browse list delivers
     *  a new intent to the existing instance instead of creating a new one. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EXTRA_PREFILL_ID)?.let { prefill ->
            input.setText(prefill)
            input.setSelection(prefill.length)
            performLookup()
        }
    }

    private fun performLookup() {
        val raw = input.text.toString()
        val id = SiteRepository.normalise(raw)
        if (id.isEmpty()) {
            hideResult()
            notFoundView.visibility = View.VISIBLE
            notFoundView.text = getString(R.string.enter_an_id)
            return
        }
        if (!SiteRepository.isLoaded) {
            loadingView.visibility = View.VISIBLE
            return
        }

        lastQuery = raw
        val matches = SiteRepository.lookup(id)

        loadingView.visibility = View.GONE
        if (matches.isEmpty()) {
            hideResult()
            notFoundView.visibility = View.VISIBLE
            notFoundView.text = getString(R.string.no_site_found, id)
            return
        }

        notFoundView.visibility = View.GONE
        val site = matches.first()
        siteIdView.text = site.siteId
        siteNameView.text = site.siteName
        towercoView.text = getString(R.string.towerco_label, site.towercoId)
        resultCard.visibility = View.VISIBLE
        resultCard.contentDescription =
            getString(R.string.result_description, site.siteId, site.siteName)
    }

    private fun hideResult() {
        resultCard.visibility = View.GONE
        notFoundView.visibility = View.GONE
    }

    private fun copyResult() {
        val text = "${siteIdView.text} - ${siteNameView.text}"
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("GPS Verify site", text))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Snackbar.make(resultCard, R.string.copied, Snackbar.LENGTH_SHORT).show()
        }
    }

    /** Dismisses the keyboard so the result is not hidden behind it. */
    private fun hideKeyboard() {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(input.windowToken, 0)
    }
}
