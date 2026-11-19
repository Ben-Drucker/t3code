package expo.modules.t3composereditor

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import com.facebook.react.common.assets.ReactFontManager
import kotlin.math.ceil
import kotlin.math.min

class T3ContextChip(
  content: Content,
  fontSize: Float,
  private val color: Int,
  maximumWidth: Float,
  density: Float
) {
  /** What the chip says: its name, the size beside it, and the glyph that leads it. */
  data class Content(
    val label: String,
    val detail: String = "",
    val iconUri: String = "",
    val tintsIcon: Boolean = false,
    val monospaced: Boolean = false,
    val swatch: Int? = null
  )

  private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = fontSize
    typeface = chipTypeface(content.monospaced)
    color = this@T3ContextChip.color
  }
  private val em = fontSize

  private val detailPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = fontSize * 0.84f
    typeface = chipTypeface(content.monospaced)
    color = this@T3ContextChip.color
  }
  private val detailText = if (content.detail.isEmpty()) "" else " ${content.detail}"
  private val detailWidth = if (detailText.isEmpty()) 0f else detailPaint.measureText(detailText)

  val iconUri = content.iconUri
  private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG).apply {
    if (content.tintsIcon) {
      colorFilter =
        PorterDuffColorFilter(this@T3ContextChip.color, PorterDuff.Mode.SRC_IN)
    }
  }
  private val padding = density * 5
  private val swatch = content.swatch
  private val swatchPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val iconSlot = when {
    content.swatch != null -> em
    iconUri.isNotEmpty() -> em * 1.25f
    else -> 0f
  }
  val width = ceil(
    min(
      maximumWidth.coerceAtLeast(em * 3),
      paint.measureText(content.label) + detailWidth + iconSlot + padding * 2
    )
  )
  val height = ceil(paint.fontMetrics.descent - paint.fontMetrics.ascent)
  private val text = TextUtils.ellipsize(
    content.label,
    paint,
    (width - iconSlot - padding * 2 - detailWidth).coerceAtLeast(0f),
    TextUtils.TruncateAt.MIDDLE
  ).toString()

  fun draw(canvas: Canvas, x: Float, y: Float) {
    canvas.save()
    canvas.translate(x, y)
    swatch?.let { exactColor ->
      swatchPaint.color = exactColor
      swatchPaint.alpha = 31
      canvas.drawRoundRect(0f, 0f, width, height, padding, padding, swatchPaint)
      val inset = padding / 10
      swatchPaint.alpha = 64
      swatchPaint.style = Paint.Style.STROKE
      swatchPaint.strokeWidth = inset * 2
      canvas.drawRoundRect(inset, inset, width - inset, height - inset, padding, padding, swatchPaint)
      swatchPaint.style = Paint.Style.FILL
      val side = em * 0.72f
      val top = (height - side) / 2
      swatchPaint.color = exactColor
      canvas.drawRoundRect(padding, top, padding + side, top + side, padding * 0.4f, padding * 0.4f, swatchPaint)
    }
    T3ChipIcons.cached(iconUri)?.let {
      val top = (height - em) / 2
      canvas.drawBitmap(it, null, RectF(padding, top, padding + em, top + em), iconPaint)
    }
    val baseline = -paint.fontMetrics.ascent
    canvas.drawText(text, padding + iconSlot, baseline, paint)
    if (detailText.isNotEmpty()) {
      canvas.drawText(
        detailText,
        padding + iconSlot + paint.measureText(text),
        baseline,
        detailPaint
      )
    }
    canvas.restore()
  }

  companion object {
    private const val CHIP_FONT_FAMILY = "DMSans-Medium"

    // Matches the iOS chips; builds without the bundled font keep the platform medium.
    private fun chipTypeface(monospaced: Boolean): Typeface {
      if (monospaced) {
        return Typeface.create(Typeface.MONOSPACE, Typeface.NORMAL)
      }
      val fonts = ReactFontManager.getInstance()
      return if (CHIP_FONT_FAMILY in fonts.customFontFamilies) {
        fonts.getTypeface(CHIP_FONT_FAMILY, Typeface.NORMAL, null)
      } else {
        Typeface.create("sans-serif-medium", Typeface.NORMAL)
      }
    }

    fun color(
      value: String,
      fallback: Int
    ): Int = runCatching {
      // React Native hex colors put alpha last; Android's parser puts it first.
      val androidColor = if (value.length == 9 && value.startsWith("#")) {
        "#${value.takeLast(2)}${value.substring(1, 7)}"
      } else {
        value
      }
      Color.parseColor(androidColor)
    }.getOrDefault(fallback)
  }
}
