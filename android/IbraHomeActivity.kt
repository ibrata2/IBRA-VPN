package com.v2ray.ang.ui

// IBRA VPN — Android home screen. برمجة وتطوير ابراهيم الخزرجي
// Copied into the v2rayNG source by android/rebrand.py and set as the launcher activity.

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.net.VpnService
import android.os.Bundle
import android.os.SystemClock
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.v2ray.ang.AppConfig
import com.v2ray.ang.core.LauncherManager
import com.v2ray.ang.enums.PermissionType
import com.v2ray.ang.handler.AngConfigManager
import com.v2ray.ang.handler.MmkvManager
import com.v2ray.ang.handler.SettingsManager
import com.v2ray.ang.handler.SpeedtestManager
import com.v2ray.ang.helper.MessageHelper
import com.v2ray.ang.ui.base.HelperBaseComponentActivity
import com.v2ray.ang.ui.main.MainActivity
import com.v2ray.ang.util.Utils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URL

private val IbraRed = Color(0xFFE3141C)
private val IbraRed2 = Color(0xFFFF4A50)
private val Card = Color(0x0EFFFFFF)
private val CardBorder = Color(0x14FFFFFF)
private val Muted = Color(0xFFA3A3A8)

class IbraHomeActivity : HelperBaseComponentActivity() {

    private var running by mutableStateOf(false)
    private var busy by mutableStateOf(false)
    private var serverCount by mutableStateOf(0)
    private var serverName by mutableStateOf("")
    private var serverPing by mutableStateOf(0L)
    private var note by mutableStateOf<String?>(null)
    private var connectedAt by mutableLongStateOf(0L)
    private var tgProxies by mutableStateOf(BUILTIN_TG)
    private var loadingTg by mutableStateOf(false)

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (it.resultCode == RESULT_OK) startCore() else { busy = false; note = "لازم توافق على إذن الـ VPN حتى يشتغل" }
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.getIntExtra("key", 0)) {
                AppConfig.MSG_STATE_RUNNING, AppConfig.MSG_STATE_START_SUCCESS -> {
                    if (!running) connectedAt = SystemClock.elapsedRealtime()
                    running = true; busy = false; note = null
                }
                AppConfig.MSG_STATE_NOT_RUNNING, AppConfig.MSG_STATE_STOP_SUCCESS -> { running = false; busy = false }
                AppConfig.MSG_STATE_START_FAILURE -> {
                    running = false; busy = false
                    note = "تعذر الاتصال: " + (intent.getStringExtra("content") ?: "")
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ContextCompat.registerReceiver(this, receiver, IntentFilter(AppConfig.BROADCAST_ACTION_ACTIVITY), Utils.receiverFlags())
        MessageHelper.sendMsg2Service(this, AppConfig.MSG_REGISTER_CLIENT, "")
        checkAndRequestPermission(PermissionType.POST_NOTIFICATIONS) {}
        refreshSelected()
        // first launch: download the free servers right away
        if (MmkvManager.decodeAllServerList().isEmpty()) fetchServers(silent = true)
    }

    override fun onResume() {
        super.onResume()
        refreshSelected()
        MessageHelper.sendMsg2Service(this, AppConfig.MSG_REGISTER_CLIENT, "")
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(receiver) }
        super.onDestroy()
    }

    private fun refreshSelected() {
        val all = MmkvManager.decodeAllServerList()
        serverCount = all.size
        val guid = MmkvManager.getSelectServer()
        val cfg = guid?.let { MmkvManager.decodeServerConfig(it) }
        serverName = cfg?.remarks.orEmpty()
        serverPing = guid?.let { MmkvManager.decodeServerAffiliationInfo(it)?.testDelayMillis } ?: 0L
    }

    private fun toggle() {
        if (busy) return
        if (running) {
            busy = true
            LauncherManager.stopService(this)
            return
        }
        if (MmkvManager.getSelectServer().isNullOrEmpty()) {
            if (serverCount == 0) { fetchServers(connectAfter = true); return }
            pickBest()
        }
        busy = true
        if (SettingsManager.isVpnMode()) {
            val intent = VpnService.prepare(this)
            if (intent != null) { vpnPermission.launch(intent); return }
        }
        startCore()
    }

    private fun startCore() {
        LauncherManager.startService(this)
        lifecycleScope.launch {
            delay(12000)
            if (busy && !running) { busy = false; MessageHelper.sendMsg2Service(this@IbraHomeActivity, AppConfig.MSG_REGISTER_CLIENT, "") }
        }
    }

    /** Downloads the free lists (subscriptions), then measures every server and selects the fastest. */
    private fun fetchServers(silent: Boolean = false, connectAfter: Boolean = false) {
        if (busy && !connectAfter) return
        busy = true
        if (!silent) note = "جاري جلب السيرفرات…"
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { AngConfigManager.updateConfigViaSubAll() } }
            val count = MmkvManager.decodeAllServerList().size
            if (count == 0) {
                busy = false
                note = "تعذر جلب السيرفرات — تأكد من الإنترنت وحاول مرة ثانية"
                refreshSelected()
                return@launch
            }
            note = "جاري فحص $count سيرفر واختيار الأسرع…"
            val best = withContext(Dispatchers.IO) { measureAll() }
            refreshSelected()
            busy = false
            note = if (best > 0) "تم — $best سيرفر شغال، واخترنا الأسرع" else "تم جلب $count سيرفر"
            if (result.isFailure && best == 0) note = "تعذر تحديث بعض القوائم"
            if (running) LauncherManager.restartService(this@IbraHomeActivity)
            else if (connectAfter) toggle()
        }
    }

    /** TCP connect time for each server; UDP-only protocols get a neutral score. Returns working count. */
    private suspend fun measureAll(): Int {
        val guids = MmkvManager.decodeAllServerList().take(400)
        val io = Dispatchers.IO.limitedParallelism(32)
        val results = kotlinx.coroutines.coroutineScope {
            guids.map { guid ->
                async(io) {
                    val cfg = MmkvManager.decodeServerConfig(guid) ?: return@async guid to -1L
                    val host = cfg.server.orEmpty()
                    val port = cfg.serverPort?.substringBefore(",")?.substringBefore("-")?.toIntOrNull() ?: return@async guid to -1L
                    val udp = cfg.configType.name.let { it.contains("HYSTERIA") || it.contains("TUIC") || it.contains("WIREGUARD") }
                    val ms = if (udp) -1L else SpeedtestManager.socketConnectTime(host, port, 2500)
                    guid to ms
                }
            }.awaitAll()
        }
        results.forEach { (g, ms) -> MmkvManager.encodeServerTestDelayMillis(g, ms) }
        val ok = results.filter { it.second > 0 }.sortedBy { it.second }
        ok.firstOrNull()?.let { MmkvManager.setSelectServer(it.first) }
        return ok.size
    }

    private fun pickBest() {
        val all = MmkvManager.decodeAllServerList()
        val best = all.mapNotNull { g -> MmkvManager.decodeServerAffiliationInfo(g)?.testDelayMillis?.takeIf { it > 0 }?.let { g to it } }
            .minByOrNull { it.second }?.first ?: all.firstOrNull()
        best?.let { MmkvManager.setSelectServer(it) }
        refreshSelected()
    }

    private fun fetchTelegram() {
        loadingTg = true
        lifecycleScope.launch {
            val more = withContext(Dispatchers.IO) {
                runCatching {
                    URL(TG_LIST_URL).readText().lines()
                        .mapNotNull { l -> l.substringAfter("proxy?", "").takeIf { it.isNotEmpty() }?.let { "tg://proxy?" + it.trim().replace(".&port", "&port") } }
                        .distinct().take(30)
                }.getOrDefault(emptyList())
            }
            loadingTg = false
            if (more.isEmpty()) note = "تعذر جلب بروكسيات جديدة" else tgProxies = (BUILTIN_TG + more).distinct()
        }
    }

    private fun open(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (e: Exception) {
            Toast.makeText(this, if (url.startsWith("tg:")) "نصّب تليكرام أولاً" else "تعذر فتح الرابط", Toast.LENGTH_SHORT).show()
        }
    }

    @Composable
    override fun ScreenContent() {
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
            Box(
                Modifier.fillMaxSize().background(Brush.radialGradient(listOf(Color(0xFF3A0508), Color(0xFF0B0B0E)), radius = 1600f))
            ) {
                Column(
                    Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 18.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp)
                ) {
                    Header()
                    PowerCard()
                    note?.let {
                        Text(it, color = Color.White, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(IbraRed.copy(alpha = 0.22f)).padding(12.dp))
                    }
                    ServersCard()
                    TelegramCard()
                    AboutCard()
                    Spacer(Modifier.height(10.dp))
                }
            }
        }
    }

    @Composable
    private fun Header() {
        CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(top = 6.dp)) {
                Text("IBRA ", color = Color.White, fontSize = 26.sp, fontWeight = FontWeight.Black)
                Text("VPN", color = IbraRed, fontSize = 26.sp, fontWeight = FontWeight.Black)
            }
        }
    }

    @Composable
    private fun IbraCard(content: @Composable () -> Unit) {
        Column(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(Card).border(1.dp, CardBorder, RoundedCornerShape(20.dp)).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) { content() }
    }

    @Composable
    private fun PowerCard() {
        IbraCard {
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    Modifier.size(190.dp).clip(CircleShape).border(14.dp, if (running) IbraRed.copy(alpha = 0.45f) else Color(0x14FFFFFF), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Box(
                        Modifier.size(140.dp).shadow(if (running) 30.dp else 0.dp, CircleShape, spotColor = IbraRed).clip(CircleShape)
                            .background(if (running) Brush.verticalGradient(listOf(IbraRed2, IbraRed)) else Brush.verticalGradient(listOf(Color(0x18FFFFFF), Color(0x0CFFFFFF))))
                            .clickable { toggle() },
                        contentAlignment = Alignment.Center
                    ) {
                        if (busy) CircularProgressIndicator(color = Color.White, strokeWidth = 4.dp, modifier = Modifier.size(54.dp))
                        else Text("⏻", color = if (running) Color.White else Color.Gray, fontSize = 60.sp, fontWeight = FontWeight.Bold)
                    }
                }
                Text(
                    when { busy && !running -> "جاري الاتصال…"; busy -> "جاري القطع…"; running -> "متصل ومحمي"; else -> "غير متصل" },
                    color = if (running) IbraRed2 else Color.White, fontSize = 20.sp, fontWeight = FontWeight.Black
                )
                if (running && connectedAt > 0) {
                    var now by androidx.compose.runtime.remember { mutableLongStateOf(SystemClock.elapsedRealtime()) }
                    LaunchedEffect(connectedAt) { while (true) { now = SystemClock.elapsedRealtime(); delay(1000) } }
                    val s = ((now - connectedAt) / 1000).coerceAtLeast(0)
                    Text(String.format("%02d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60), color = Muted, fontSize = 15.sp)
                }
                if (serverName.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Color(0x0AFFFFFF)).padding(12.dp)) {
                        Text(serverName, color = Color.White, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        if (serverPing > 0) Text("$serverPing ms", color = Color(0xFF3DDC84), fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
            }
        }
    }

    @Composable
    private fun ServersCard() {
        IbraCard {
            Text("السيرفرات المجانية", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Text(if (serverCount > 0) "$serverCount سيرفر — نفحصها ونختار الأسرع تلقائياً" else "اضغط \"جلب سيرفرات جديدة\" حتى تنزل السيرفرات", color = Muted, fontSize = 13.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(onClick = { fetchServers() }, enabled = !busy, colors = ButtonDefaults.buttonColors(containerColor = IbraRed), modifier = Modifier.weight(1f)) {
                    Text("جلب سيرفرات جديدة", fontWeight = FontWeight.Bold)
                }
                OutlinedButton(onClick = { startActivity(Intent(this@IbraHomeActivity, MainActivity::class.java)) }, border = BorderStroke(1.dp, Color(0x33FFFFFF)), modifier = Modifier.weight(1f)) {
                    Text("كل السيرفرات", color = Color.White)
                }
            }
            Text("✓ يدعم VLESS · VMess · Trojan · Shadowsocks · Hysteria2 والاشتراكات — تضيفها من \"كل السيرفرات\"", color = Muted, fontSize = 11.sp)
        }
    }

    @Composable
    private fun TelegramCard() {
        IbraCard {
            Text("بروكسيات تليكرام", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.Bold)
            Text("تشتغل داخل تليكرام فقط — اضغط اتصال وتليكرام يضيفها", color = Muted, fontSize = 12.sp)
            tgProxies.forEachIndexed { i, link ->
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text("بروكسي ${i + 1}", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                        Text(Uri.parse(link).getQueryParameter("server").orEmpty(), color = Muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    Button(onClick = { open(link) }, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2AABEE))) { Text("اتصال", fontWeight = FontWeight.Bold) }
                }
            }
            OutlinedButton(onClick = { fetchTelegram() }, enabled = !loadingTg, border = BorderStroke(1.dp, Color(0x33FFFFFF)), modifier = Modifier.fillMaxWidth()) {
                Text(if (loadingTg) "جاري الجلب…" else "جلب بروكسيات جديدة", color = Color.White)
            }
        }
    }

    @Composable
    private fun AboutCard() {
        IbraCard {
            Text("برمجة وتطوير ابراهيم الخزرجي", color = IbraRed2, fontSize = 17.sp, fontWeight = FontWeight.Black, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            LinkRow("🌐  كل تطبيقاتي · ibraprogram.netlify.app", SITE_URL, highlight = true)
            LinkRow("✈️  Telegram · ibraprogram", TG_URL)
            LinkRow("🎵  TikTok · ibraprogram", TIKTOK_URL)
        }
    }

    @Composable
    private fun LinkRow(title: String, url: String, highlight: Boolean = false) {
        Text(
            title, color = Color.White, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp))
                .background(if (highlight) IbraRed.copy(alpha = 0.22f) else Color(0x10FFFFFF))
                .border(1.dp, if (highlight) IbraRed else Color(0x1AFFFFFF), RoundedCornerShape(12.dp))
                .clickable { open(url) }.padding(vertical = 12.dp)
        )
    }

    companion object {
        const val SITE_URL = "https://ibraprogram.netlify.app/"
        const val TG_URL = "https://t.me/ibraprogram"
        const val TIKTOK_URL = "https://www.tiktok.com/@ibraprogram"
        const val TG_LIST_URL = "https://raw.githubusercontent.com/SoliSpirit/mtproto/master/all_proxies.txt"
        val BUILTIN_TG = listOf(
            "tg://proxy?server=fast.strobox.info&port=443&secret=ddf0eeb0bd9adc4fd4a93994ee3b2a216b",
            "tg://proxy?server=Tond.strobox.info&port=443&secret=ddf0eeb0bd9adc4fd4a93994ee3b2a216b"
        )
    }
}
