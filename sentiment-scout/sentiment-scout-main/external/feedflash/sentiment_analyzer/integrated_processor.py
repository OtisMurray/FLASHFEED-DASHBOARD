import logging
import re
import pandas as pd
import numpy as np
import joblib
import os
import torch
import nltk

# --- AUTO-FIX: DOWNLOAD VADER IF MISSING ---
try:
    nltk.data.find('sentiment/vader_lexicon.zip')
except LookupError:
    print("⬇️ Downloading VADER Lexicon for the first time...")
    nltk.download('vader_lexicon', quiet=True)

# --- IMPORT FIXED SCORER ---
try:
    from sentiment_scorer import SentimentScorer
except ImportError:
    print("⚠️ Critical Warning: sentiment_scorer.py not found. VADER/FinBERT will fail.")

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("IntegratedProcessor")

class DynamicSentimentLearner:
    """
    (KRIS LOGIC)
    Handles the Custom Dictionary and Statistical ML models.
    """
    def __init__(self):
        self.sentiment_weights = {}
        self.sentiment_model = None
        self.vectorizer = None
        self.scaler = None
        
        # Load models and dictionary
        self._load_existing_models()
        self.load_sentiment_keywords_from_csv()

    def _load_existing_models(self):
        """Loads pre-trained ML models if available."""
        model_files = ["sentiment_model_enhanced.pkl", "vectorizer_enhanced.pkl", "scaler_enhanced.pkl"]
        loaded = {}
        
        base_dir = os.path.dirname(os.path.abspath(__file__))
        for fname in model_files:
            paths = [
                os.path.join(base_dir, fname),
                os.path.join(base_dir, "models", fname)
            ]
            for p in paths:
                if os.path.exists(p):
                    try:
                        loaded[fname] = joblib.load(p)
                        break
                    except Exception:
                        pass

        self.sentiment_model = loaded.get("sentiment_model_enhanced.pkl")
        self.vectorizer = loaded.get("vectorizer_enhanced.pkl")
        self.scaler = loaded.get("scaler_enhanced.pkl")

    def load_sentiment_keywords_from_csv(self, csv_filename="sentiment_keywords.csv"):
        """Loads the keyword dictionary from CSV, USING THE NEW STRENGTH COLUMN."""
        base_dir = os.path.dirname(os.path.abspath(__file__))
        csv_path = os.path.join(base_dir, csv_filename)
        if os.path.exists(csv_path):
            try:
                df = pd.read_csv(csv_path)
                count = 0
                for _, row in df.iterrows():
                    keyword = str(row['keyword']).lower().strip()
                    sentiment = str(row['sentiment']).lower().strip()
                    
                    # --- READ STRENGTH ---
                    strength = float(row.get('strength', 1.0))
                    
                    # Determine Direction
                    direction = 1.0 if sentiment == 'positive' else -1.0 if sentiment == 'negative' else 0.0
                    
                    if direction != 0.0:
                        # Multiply Direction * Strength
                        self.sentiment_weights[keyword] = direction * strength
                        count += 1
                        
                logger.info(f"✅ Loaded {count} keywords with strength scores from CSV.")
                
            except Exception as e:
                logger.warning(f"Error loading CSV dictionary: {e}")
        else:
            logger.warning(f"⚠️ '{csv_path}' not found. Using fallback dictionary.")
            # Fallback default dictionary
            self.sentiment_weights = {
                'growth': 1.0, 'profit': 1.0, 'surge': 1.0, 'bullish': 1.0, 
                'loss': -1.0, 'drop': -1.0, 'decline': -1.0, 'bearish': -1.0
            }

    def predict_ml_sentiment(self, text):
        """Predicts using Kris's trained ML model."""
        if not self.sentiment_model or not self.vectorizer or not text:
            return 0.0
        try:
            clean_text = re.sub(r'[^\w\s]', ' ', text.lower())
            vec = self.vectorizer.transform([clean_text]).toarray()
            prob = self.sentiment_model.predict_proba(vec)[0][1]
            return (prob - 0.5) * 2 
        except Exception:
            return 0.0

    def calculate_keyword_score(self, text):
        """
        Calculates score based on Kris's Dictionary (Supports Plurals & Strength).
        IMPROVED: Now handles multi-word phrases with fuzzy matching.
        """
        if not text: return 0.0
        
        text_lower = text.lower()
        score = 0.0
        count = 0
        matched_phrases = set()  # Track what we've already counted
        
        # 1. FIRST PASS: Check for multi-word phrases
        for keyword, weight in self.sentiment_weights.items():
            if ' ' in keyword or '-' in keyword:  # Multi-word phrase
                # Replace hyphens with spaces for matching flexibility
                keyword_normalized = keyword.replace('-', ' ')
                keyword_parts = keyword_normalized.split()
                
                # FUZZY MATCH: Check if all parts appear in order (allowing words between)
                if len(keyword_parts) >= 2:
                    # Use regex to allow optional words between parts
                    # e.g., "turned into" matches "turned $1,000 into"
                    pattern = r'\b' + r'\b.*?\b'.join(re.escape(part) for part in keyword_parts) + r'\b'
                    if re.search(pattern, text_lower):
                        score += weight
                        count += 1
                        matched_phrases.add(keyword_normalized)
                        continue
                
                # EXACT MATCH: Fallback for simple phrases
                if keyword_normalized in text_lower:
                    score += weight
                    count += 1
                    matched_phrases.add(keyword_normalized)
        
        # 2. SECOND PASS: Check individual words (skip if part of matched phrase)
        words = re.findall(r'\b\w+\b', text_lower)
        for w in words:
            # Skip if this word was part of a multi-word phrase we already matched
            if any(w in phrase for phrase in matched_phrases):
                continue
                
            weight = 0.0
            # Check Exact Match
            if w in self.sentiment_weights:
                weight = self.sentiment_weights[w]
            # Check Singular Form (remove 's')
            elif w.endswith('s') and w[:-1] in self.sentiment_weights:
                weight = self.sentiment_weights[w[:-1]]
            
            if weight != 0.0:
                score += weight
                count += 1
                
        # Preserve strength information but prevent outliers
        if count > 0:
            avg_score = score / count
            return max(-3.0, min(3.0, avg_score))
        return 0.0


class QuestionSentimentDetector:
    """
    NEW: Detects sentiment in question-format headlines.
    """
    @staticmethod
    def detect_question_sentiment(text):
        """Extract sentiment from question headlines."""
        if not text:
            return 0.0
            
        text_lower = text.lower()
        
        # CAUTION: "before buying" / "before you buy" = cautionary
        if 'before buying' in text_lower or 'before you buy' in text_lower:
            return -0.2  # Mildly cautionary
        
        # CAUTION: "what to know" = educational/neutral
        if 'what to know' in text_lower:
            return 0.0  # Neutral educational content
        
        # Strong positive patterns
        if 'once-in-a-decade' in text_lower or 'once in a decade' in text_lower:
            return 0.6
        if 'buying opportunity' in text_lower:
            return 0.5
        
        # Positive question patterns with price targets or growth
        if re.search(r'(can|will|could).*(reach|hit|surge|soar|climb)', text_lower):
            return 0.4
        if re.search(r'(can|will|could).*(keep running|keep rising|outperform)', text_lower):
            return 0.4
        if re.search(r'(could|will).*(heading higher|go higher|rise)', text_lower):
            return 0.3
        
        # "Best" stocks questions
        if 'best' in text_lower and ('buy' in text_lower or 'stock' in text_lower):
            return 0.4
        
        # Overlooked/undervalued (positive in investment context)
        if 'overlooked' in text_lower or 'undervalued' in text_lower:
            return 0.3
        
        # Negative question patterns
        if 'should you avoid' in text_lower or "don't buy" in text_lower:
            return -0.5
        if 'overvalued' in text_lower or 'bubble' in text_lower:
            return -0.4
        
        return 0.0  # Neutral question


class FinancialSentimentProcessor:
    """
    THE MERGED ENGINE (FIXED):
    Integrates Josh's Scorer (FinBERT + VADER) and Kris's Learner (Dict + ML).
    """
    def __init__(self):
        # 1. Initialize Josh's Engine
        logger.info("🧠 Initializing Sentiment Engines...")
        try:
            self.josh_scorer = SentimentScorer(use_cuda=True)
            logger.info("✅ Josh's Scorer (FinBERT + VADER) Active")
        except Exception as e:
            logger.error(f"❌ Failed to load Josh's Scorer: {e}")
            self.josh_scorer = None
        
        # 2. Initialize Kris's Engine
        self.kris_learner = DynamicSentimentLearner()
        logger.info("✅ Kris's Learner (Dictionary + ML) Active")
        
        # 3. Initialize Question Detector
        self.question_detector = QuestionSentimentDetector()
        logger.info("✅ Question Sentiment Detector Active")

    def calculate_enhanced_sentiment(self, text):
        """
        Calculates the Grand Unified Score (FIXED).
        """
        if not text:
            return {}

        # --- A. GET COMPONENT SCORES ---
        
        # 1. Josh's Scores (FinBERT & VADER)
        finbert_score = 0.0
        vader_score = 0.0
        
        if self.josh_scorer:
            try:
                results = self.josh_scorer.score(text)
                finbert_score = results.finbert if results.finbert is not None else 0.0  # ← FIXED
                vader_score = results.vader if results.vader is not None else 0.0
            except Exception as e:
                logger.error(f"Scoring Error: {e}")

        # 2. Kris's Scores (Dictionary & ML)
        kris_dict_score = self.kris_learner.calculate_keyword_score(text)
        kris_ml_score = self.kris_learner.predict_ml_sentiment(text)
        
        # 3. Question Pattern Detection
        question_bias = self.question_detector.detect_question_sentiment(text)

        # --- B. WEIGHTED COMBINATION ---
        # FinBERT (40%), Dictionary (35%), Question (15%), VADER (10%), ML (10%)
        # ADJUSTED: Reduced VADER weight (poor on financial text), increased Dictionary
        combined_score = (
            (finbert_score * 0.40) + 
            (kris_dict_score * 0.35) +
            (question_bias * 0.15) +
            (vader_score * 0.05) +
            (kris_ml_score * 0.05)
        )
        
        # Normalize combined score to [-1, 1] range
        combined_score = max(-1.0, min(1.0, combined_score))

        # --- C. RETURN FORMAT ---
        return {
            "ml_prediction": finbert_score,    # FinBERT
            "keyword_based": kris_dict_score,  # Dictionary (preserves strength)
            "dynamic_weights": kris_ml_score,  # Kris's ML model
            "sentiment_vader": vader_score,    # VADER
            "question_bias": question_bias,    # Question pattern detection
            "combined": combined_score         # Weighted average
        }

if __name__ == "__main__":
    # Test
    proc = FinancialSentimentProcessor()
    
    # Test cases
    test_texts = [
        "NVIDIA stock surges 10% on record revenue.",
        "Company reports bankruptcy fears amid declining sales.",
        "FDA approval granted for breakthrough drug treatment.",
        "Brazil's largest private bank advises 3% Bitcoin allocation for clients.",
        "US Navy bets $448M on Palantir AI to speed shipbuilding.",
        "Is D-Wave Quantum one of the most overlooked tech stories?",
        "Can Block shares keep running and reach $100 in 2026?",
        "2 Stocks That Turned $1,000 Into $1 Million (or More)",
        "What to know before buying The Metals Company stock.",
    ]
    
    print("\n" + "="*80)
    print("TESTING FIXED ENHANCED SENTIMENT PROCESSOR")
    print("="*80)
    
    for txt in test_texts:
        print(f"\nTEXT: {txt}")
        scores = proc.calculate_enhanced_sentiment(txt)
        print(f"  FinBERT:    {scores['ml_prediction']:+.3f}")
        print(f"  Dictionary: {scores['keyword_based']:+.3f}")
        print(f"  VADER:      {scores['sentiment_vader']:+.3f}")
        print(f"  Question:   {scores['question_bias']:+.3f}")
        print(f"  Combined:   {scores['combined']:+.3f}")
        
        # DEBUG: Show matched keywords
        if scores['keyword_based'] != 0.0:
            text_lower = txt.lower()
            matched = []
            for keyword in proc.kris_learner.sentiment_weights.keys():
                if ' ' in keyword or '-' in keyword:
                    keyword_normalized = keyword.replace('-', ' ')
                    keyword_parts = keyword_normalized.split()
                    if len(keyword_parts) >= 2:
                        pattern = r'\b' + r'\b.*?\b'.join(re.escape(part) for part in keyword_parts) + r'\b'
                        if re.search(pattern, text_lower):
                            matched.append(f'"{keyword}" ({proc.kris_learner.sentiment_weights[keyword]:+.1f})')
                    elif keyword_normalized in text_lower:
                        matched.append(f'"{keyword}" ({proc.kris_learner.sentiment_weights[keyword]:+.1f})')
                elif keyword in text_lower:
                    matched.append(f'"{keyword}" ({proc.kris_learner.sentiment_weights[keyword]:+.1f})')
            if matched:
                print(f"  Matched: {', '.join(matched)}")