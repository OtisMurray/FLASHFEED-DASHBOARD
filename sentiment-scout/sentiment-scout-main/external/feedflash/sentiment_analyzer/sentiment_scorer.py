from dataclasses import dataclass
from nltk.sentiment.vader import SentimentIntensityAnalyzer
from transformers import pipeline
import torch
import logging
import nltk

# Suppress HuggingFace warnings
logging.getLogger("transformers").setLevel(logging.ERROR)

@dataclass
class SentimentResult:
    """Fixed dataclass with correct field names"""
    vader: float | None
    finbert: float | None  # ← FIXED: Renamed from finbert_tone

class SentimentScorer:
    """
    Ensemble Scorer: 
    1. VADER (Rule-based)
    2. FinBERT (ProsusAI - Financial sentiment specialist)
    
    All scores normalized to [-1, 1].
    """

    def __init__(self, use_cuda=True):
        self.device = 0 if use_cuda and torch.cuda.is_available() else -1
        print(f"Loading Sentiment Models on device: {'GPU' if self.device==0 else 'CPU'}...")

        # --- 1. VADER ---
        try:
            self.vader_analyzer = SentimentIntensityAnalyzer()
        except LookupError:
            print("Downloading VADER lexicon...")
            nltk.download('vader_lexicon')
            self.vader_analyzer = SentimentIntensityAnalyzer()

        # --- 2. FinBERT (ProsusAI) - Financial Sentiment Specialist ---
        print("Loading FinBERT (ProsusAI)...")
        self.finbert_pipeline = pipeline(
            "text-classification",
            model="ProsusAI/finbert",
            tokenizer="ProsusAI/finbert",
            device=self.device,
            truncation=True,
            max_length=512,
        )
        print("✅ All sentiment models loaded successfully.")

    def score(self, text: str) -> SentimentResult:
        """Return sentiment scores for a given text using all enabled models."""
        if not text or not text.strip():
            return SentimentResult(vader=0.0, finbert=0.0)

        # VADER Score
        vader_score = self._score_vader(text)

        # FinBERT Score
        finbert_score = self._score_finbert(text)

        return SentimentResult(
            vader=vader_score, 
            finbert=finbert_score
        )

    def _score_vader(self, text: str) -> float:
        """VADER Compound score is already [-1, 1]"""
        try:
            scores = self.vader_analyzer.polarity_scores(text)
            return float(scores["compound"])
        except Exception as e:
            logging.error(f"VADER error: {e}")
            return 0.0

    def _score_finbert(self, text: str) -> float:
        """
        FinBERT scorer using ProsusAI model.
        Maps labels (positive/negative/neutral) to [-1, 1].
        
        IMPROVED: For neutral predictions, we apply a small bias based on
        confidence level to avoid complete silence on strategic news.
        """
        try:
            output = self.finbert_pipeline(text)[0]  # {'label': 'positive', 'score': 0.99}
            label = output['label'].lower()
            confidence = float(output['score'])

            if 'positive' in label:
                return confidence
            elif 'negative' in label:
                return -confidence
            else:
                # IMPROVED: Neutral handling
                # If FinBERT is uncertain (confidence < 0.7), apply small positive bias
                # (Financial news tends to be slightly optimistic when neutral)
                if confidence < 0.7:
                    return 0.15  # Mild positive bias for uncertain neutrals
                elif confidence < 0.85:
                    return 0.05  # Tiny bias for somewhat confident neutrals
                return 0.0  # High-confidence neutral = truly neutral
        except Exception as e:
            logging.error(f"FinBERT scoring error: {e}")
            return 0.0

if __name__ == "__main__":
    # Test the fixed scorer
    scorer = SentimentScorer()
    
    test_cases = [
        "Nvidia reports record breaking revenue, stock soars.",
        "Company files for bankruptcy amid mounting losses.",
        "Brazil's largest private bank advises 3% Bitcoin allocation for clients.",
        "Is D-Wave Quantum one of the most overlooked tech stories of the decade?",
    ]
    
    print("\n" + "="*60)
    print("TESTING FIXED SENTIMENT SCORER")
    print("="*60)
    
    for text in test_cases:
        result = scorer.score(text)
        print(f"\nText: {text}")
        print(f"  VADER:   {result.vader:.3f}")
        print(f"  FinBERT: {result.finbert:.3f}")